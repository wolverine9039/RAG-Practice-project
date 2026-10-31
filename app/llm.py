"""Gemini (Vertex AI) client layer: chat models, embeddings, daily usage cap, caches, JSON parsing.

Auth: Application Default Credentials (`gcloud auth application-default login`), or a service-account key file
in GOOGLE_APPLICATION_CREDENTIALS. Usage is billed to the Google Cloud project in GOOGLE_CLOUD_PROJECT.
"""
import asyncio
import hashlib
import json
import logging
import os
import re
import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from functools import lru_cache

from langchain_core.embeddings import Embeddings
from langchain_core.messages import BaseMessage

from app.config import settings
from app.observability import trace_embedding

logger = logging.getLogger(__name__)

DAILY_LIMIT_MESSAGE = "The daily usage cap of the AI service has been reached. Please try again tomorrow."
AUTH_HELP = (
    "Google Cloud authentication failed. Run `gcloud auth application-default login` (local) or set "
    "GOOGLE_APPLICATION_CREDENTIALS to a service-account key with the Vertex AI User role, and check that "
    "GOOGLE_CLOUD_PROJECT has the Vertex AI API enabled."
)


class DailyLimitReached(Exception):
    """The local daily request cap (DAILY_REQUEST_BUDGET) is exhausted."""


# ---------------- daily usage cap ----------------
class UsageTracker:
    """Counts model requests per UTC day and stops at DAILY_REQUEST_BUDGET (protects cloud credits)."""

    def __init__(self) -> None:
        self.path = settings.cache_path / "usage.json"
        self.lock = threading.Lock()

    @staticmethod
    def _today() -> str:
        return datetime.now(timezone.utc).strftime("%Y-%m-%d")

    def _load(self) -> dict:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            data = {}
        return data if data.get("date") == self._today() else {"date": self._today(), "count": 0}

    def today(self) -> int:
        with self.lock:
            return self._load()["count"]

    def reserve(self, n: int = 1) -> None:
        with self.lock:
            data = self._load()
            if data["count"] + n > settings.DAILY_REQUEST_BUDGET:
                raise DailyLimitReached(DAILY_LIMIT_MESSAGE)
            data["count"] += n
            self.path.write_text(json.dumps(data), encoding="utf-8")


usage = UsageTracker()


# ---------------- small sqlite key/value cache ----------------
class KVCache:
    def __init__(self, name: str) -> None:
        self.path = settings.cache_path / f"{name}.sqlite3"
        self.lock = threading.Lock()
        with sqlite3.connect(self.path) as con:
            con.execute("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)")

    @staticmethod
    def key(*parts: str) -> str:
        return hashlib.sha256("\x1f".join(parts).encode()).hexdigest()

    def get(self, k: str):
        with self.lock, sqlite3.connect(self.path) as con:
            row = con.execute("SELECT v FROM kv WHERE k = ?", (k,)).fetchone()
        return json.loads(row[0]) if row else None

    def set(self, k: str, value) -> None:
        with self.lock, sqlite3.connect(self.path) as con:
            con.execute("INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)", (k, json.dumps(value)))


# ---------------- Google Cloud auth / clients ----------------
@lru_cache
def _credentials():
    """Credentials from GOOGLE_APPLICATION_CREDENTIALS if set (service-account key or user ADC file),
    else None (= Application Default Credentials: gcloud login locally, metadata server on Cloud Run)."""
    path = settings.credentials_path
    if path is None:
        return None
    import google.auth

    creds, _ = google.auth.load_credentials_from_file(
        str(path), scopes=["https://www.googleapis.com/auth/cloud-platform"]
    )
    return creds


@lru_cache
def _project() -> str:
    if settings.GOOGLE_CLOUD_PROJECT:
        # Libraries that call google.auth.default() themselves read the project from the environment
        os.environ.setdefault("GOOGLE_CLOUD_PROJECT", settings.GOOGLE_CLOUD_PROJECT)
        return settings.GOOGLE_CLOUD_PROJECT
    import google.auth

    _, project = google.auth.default()
    if not project:
        raise RuntimeError("GOOGLE_CLOUD_PROJECT is not set in .env")
    return project


_client_lock = threading.Lock()
_client = None


def get_genai_client():
    """One shared google-genai client. Created under a lock: with lru_cache, parallel first calls could each
    build a client, and the uncached ones close their connection when garbage-collected mid-request."""
    global _client
    if _client is None:
        with _client_lock:
            if _client is None:
                from google import genai

                _client = genai.Client(vertexai=True, project=_project(), location=settings.GOOGLE_CLOUD_LOCATION,
                                       credentials=_credentials())
    return _client


def reset_genai_client() -> None:
    """Drop the shared client (its async transport is bound to the event loop that first used it)."""
    global _client
    with _client_lock:
        _client = None


ROLES = {
    # role: (model setting, thinking-level setting)
    "router": ("ROUTER_MODEL", "ROUTER_THINKING"),
    "answer": ("ANSWER_MODEL", "ANSWER_THINKING"),
}


def model_for(role: str) -> str:
    return getattr(settings, ROLES[role][0])


@lru_cache
def get_chat_model(role: str = "answer", json_mode: bool = True):
    """Gemini chat model on Vertex AI for a graph role (router = analyze/rewrite, answer = grounded answer)."""
    from langchain_google_genai import ChatGoogleGenerativeAI

    model_key, thinking_key = ROLES[role]
    model = getattr(settings, model_key)
    kwargs = dict(
        model=model,
        project=_project(),
        location=settings.GOOGLE_CLOUD_LOCATION,
        thinking_level=getattr(settings, thinking_key),
        max_output_tokens=settings.LLM_MAX_TOKENS,
        timeout=60,
        max_retries=0,  # retries happen in call_llm so every attempt is counted
    )
    if "lite" not in model:  # Flash-Lite uses fixed sampling and ignores temperature (with a warning)
        kwargs["temperature"] = settings.LLM_TEMPERATURE
    if json_mode:
        kwargs["response_mime_type"] = "application/json"
    if (creds := _credentials()) is not None:
        kwargs["credentials"] = creds
    return ChatGoogleGenerativeAI(**kwargs)


def _text(content) -> str:
    if isinstance(content, list):
        return "".join(p.get("text", "") if isinstance(p, dict) else str(p) for p in content)
    return content or ""


def _error_code(err: BaseException) -> int | None:
    """HTTP-ish status code of a Google GenAI error (also when wrapped by LangChain)."""
    for e in (err, err.__cause__, err.__context__):
        if e is None:
            continue
        code = getattr(e, "code", None) or getattr(e, "status_code", None)
        if isinstance(code, int):
            return code
    text = str(err)
    for code, marker in ((429, "RESOURCE_EXHAUSTED"), (503, "UNAVAILABLE"), (500, "INTERNAL"),
                         (403, "PERMISSION_DENIED"), (401, "UNAUTHENTICATED")):
        if marker in text or f" {code} " in f" {text} ":
            return code
    return None


def _is_auth_error(err: BaseException) -> bool:
    try:
        from google.auth import exceptions as gexc

        if isinstance(err, (gexc.DefaultCredentialsError, gexc.RefreshError)):
            return True
    except ImportError:
        pass
    return _error_code(err) in (401, 403)


def _retry_wait(err: BaseException, attempt: int) -> float | None:
    """Seconds to wait before retrying, or None if the error is not retryable."""
    code = _error_code(err)
    if code == 429:
        return 5.0 * (attempt + 1)  # Vertex per-minute quota
    if code in (500, 502, 503, 504) or isinstance(err, (TimeoutError, ConnectionError)):
        return 2.0 * (attempt + 1)
    return None


async def call_llm(messages: list[BaseMessage], role: str = "answer", json_mode: bool = True) -> str:
    """One Gemini request (counted against the daily cap), with limited retries on quota/server errors."""
    for attempt in range(3):
        usage.reserve()
        try:
            result = await get_chat_model(role, json_mode).ainvoke(messages)
        except Exception as err:
            if _is_auth_error(err):
                raise RuntimeError(AUTH_HELP) from err
            wait = _retry_wait(err, attempt)
            if wait is None or attempt == 2:
                raise
            logger.warning("Gemini %s error (%s); retrying in %.0fs", role, _error_code(err), wait)
            await asyncio.sleep(wait)
            continue
        model = result.response_metadata.get("model_name", model_for(role))
        logger.info("LLM answered by %s", model)
        text = _text(result.content).strip()
        if not text:
            logger.warning("LLM %s returned an empty answer (finish_reason=%s); thinking may have used up "
                           "LLM_MAX_TOKENS", model, result.response_metadata.get("finish_reason"))
        return text
    raise RuntimeError("unreachable")


# ---------------- embeddings ----------------
class GeminiEmbeddings(Embeddings):
    """Gemini embeddings on Vertex AI.

    gemini-embedding-2 embeds one text per request and ignores task_type, so the task goes in a text prefix
    (EMBED_QUERY_PREFIX / EMBED_DOC_PREFIX) and documents are embedded with EMBED_CONCURRENCY parallel requests.
    Query embeddings are cached on disk and traced to Langfuse; bulk document embedding (ingest) is not traced.
    """

    def __init__(self) -> None:
        self.query_cache = KVCache("query_embeddings")

    @staticmethod
    def _config():
        from google.genai import types

        return types.EmbedContentConfig(output_dimensionality=settings.EMBED_DIMENSIONS)

    @staticmethod
    def _vector(resp) -> tuple[list[float], int | None]:
        if not getattr(resp, "embeddings", None):
            raise RuntimeError(f"Embedding request returned no data: {resp}")
        emb = resp.embeddings[0]
        tokens = getattr(getattr(emb, "statistics", None), "token_count", None)
        return list(emb.values), int(tokens) if tokens is not None else None

    def _embed_one(self, text: str) -> list[float]:
        for attempt in range(3):
            usage.reserve()
            try:
                resp = get_genai_client().models.embed_content(
                    model=settings.EMBED_MODEL, contents=text, config=self._config())
                return self._vector(resp)[0]
            except Exception as err:
                if _is_auth_error(err):
                    raise RuntimeError(AUTH_HELP) from err
                wait = _retry_wait(err, attempt)
                if wait is None or attempt == 2:
                    raise
                time.sleep(wait)
        raise RuntimeError("unreachable")

    async def _aembed_one(self, text: str, traced: bool = False) -> list[float]:
        for attempt in range(3):
            usage.reserve()
            try:
                if traced:
                    with trace_embedding(settings.EMBED_MODEL, [text]) as obs:
                        resp = await get_genai_client().aio.models.embed_content(
                            model=settings.EMBED_MODEL, contents=text, config=self._config())
                        vec, tokens = self._vector(resp)
                        if tokens is not None:
                            obs.update(usage_details={"input": tokens}, output={"dimensions": len(vec)})
                        return vec
                resp = await get_genai_client().aio.models.embed_content(
                    model=settings.EMBED_MODEL, contents=text, config=self._config())
                return self._vector(resp)[0]
            except Exception as err:
                if _is_auth_error(err):
                    raise RuntimeError(AUTH_HELP) from err
                wait = _retry_wait(err, attempt)
                if wait is None or attempt == 2:
                    raise
                await asyncio.sleep(wait)
        raise RuntimeError("unreachable")

    def _query_key(self, text: str) -> str:
        return KVCache.key(settings.EMBED_MODEL, str(settings.EMBED_DIMENSIONS), settings.EMBED_QUERY_PREFIX + text)

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        prefixed = [settings.EMBED_DOC_PREFIX + t for t in texts]
        get_genai_client()  # create the shared client before the worker threads start
        with ThreadPoolExecutor(max_workers=max(1, settings.EMBED_CONCURRENCY)) as pool:
            return list(pool.map(self._embed_one, prefixed))

    async def aembed_documents(self, texts: list[str]) -> list[list[float]]:
        sem = asyncio.Semaphore(max(1, settings.EMBED_CONCURRENCY))

        async def one(t: str) -> list[float]:
            async with sem:
                return await self._aembed_one(settings.EMBED_DOC_PREFIX + t)

        return await asyncio.gather(*(one(t) for t in texts))

    def embed_query(self, text: str) -> list[float]:
        k = self._query_key(text)
        if (vec := self.query_cache.get(k)) is not None:
            return vec
        vec = self._embed_one(settings.EMBED_QUERY_PREFIX + text)
        self.query_cache.set(k, vec)
        return vec

    async def aembed_query(self, text: str) -> list[float]:
        k = self._query_key(text)
        if (vec := self.query_cache.get(k)) is not None:
            return vec
        vec = await self._aembed_one(settings.EMBED_QUERY_PREFIX + text, traced=True)
        self.query_cache.set(k, vec)
        return vec


# ---------------- helpers ----------------
def parse_json(text: str) -> dict | None:
    """Extract a JSON object from model output (handles code fences and extra prose)."""
    if not text:
        return None
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip(), flags=re.I)
    for candidate in (cleaned, cleaned[cleaned.find("{") : cleaned.rfind("}") + 1]):
        try:
            data = json.loads(candidate)
            if isinstance(data, dict):
                return data
        except ValueError:
            continue
    return None


_status_cache: dict = {"at": 0.0, "value": None}


def gemini_status() -> dict:
    """Vertex AI connectivity: auth + the configured models exist (metadata calls only, cached 5 minutes)."""
    if _status_cache["value"] is not None and time.time() - _status_cache["at"] < 300:
        return _status_cache["value"]
    status = {"project": settings.GOOGLE_CLOUD_PROJECT or None, "location": settings.GOOGLE_CLOUD_LOCATION,
              "router_model": settings.ROUTER_MODEL, "answer_model": settings.ANSWER_MODEL,
              "embed_model": settings.EMBED_MODEL, "auth": "key-file" if settings.credentials_path else "adc"}
    try:
        status["project"] = _project()
        client = get_genai_client()
        for m in {settings.ROUTER_MODEL, settings.ANSWER_MODEL, settings.EMBED_MODEL}:
            client.models.get(model=m)
        status["ok"] = True
    except Exception as err:
        status.update(ok=False, error=(AUTH_HELP if _is_auth_error(err) else str(err))[:300])
    _status_cache.update(at=time.time(), value=status)
    return status
