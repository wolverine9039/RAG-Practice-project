"""FastAPI app exposing the LangGraph RAG chatbot (API only; the WordPress plugin is the user interface)."""
import logging
import os
import re
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import Depends, FastAPI, Header, HTTPException, Response
from fastapi.concurrency import run_in_threadpool
from langchain_core.messages import AIMessage, HumanMessage
from pydantic import BaseModel, Field

from app.config import settings
from app.graph import build_graph
from app.ingest import ingest
from app.llm import DAILY_LIMIT_MESSAGE, DailyLimitReached, KVCache, gemini_status, usage
from app.observability import auth_ok, callback_handler, flush, score, trace_turn
from app.prompts import ANALYZE_PROMPT, ANSWER_PROMPT
from app.vectorstore import collection_count

logging.basicConfig(level=settings.LOG_LEVEL)
logger = logging.getLogger(__name__)

# Changing a prompt invalidates cached answers
PROMPT_FINGERPRINT = KVCache.key(repr(ANALYZE_PROMPT.messages), repr(ANSWER_PROMPT.messages))


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.graph = build_graph()
    app.state.answer_cache = KVCache("answers")
    if settings.AUTO_INGEST_ON_STARTUP and collection_count() == 0:
        logger.info("Chroma collection empty - ingesting PDFs from %s", settings.data_path)
        try:
            await run_in_threadpool(ingest)
        except Exception:
            logger.exception("Auto-ingest failed (check Google Cloud auth: gcloud auth application-default login)")
    yield
    flush()  # send any buffered Langfuse events before shutdown


app = FastAPI(title="UNO Rulebook RAG Chatbot", lifespan=lifespan)


async def require_api_key(x_api_key: str | None = Header(default=None)) -> None:
    """WordPress (or any client) must send the shared secret when BACKEND_API_KEY is set."""
    if settings.BACKEND_API_KEY and x_api_key != settings.BACKEND_API_KEY:
        raise HTTPException(status_code=401, detail="Invalid or missing X-API-Key")


# ---------------- schemas ----------------
class ChatRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=1000)
    session_id: str = Field("default", max_length=100)
    visitor: str | None = Field(None, max_length=64)  # anonymous visitor hash from WordPress (never a raw IP)


class Source(BaseModel):
    source: str
    page: int | None = None


class ChatResponse(BaseModel):
    answer: str
    sources: list[Source]
    cached: bool = False
    trace_id: str | None = None  # Langfuse trace of this turn (used for feedback); None when monitoring is off


class IngestRequest(BaseModel):
    reset: bool = False


class FeedbackRequest(BaseModel):
    trace_id: str = Field(..., pattern=r"^[0-9a-f]{32}$")
    value: Literal[1, -1]
    comment: str | None = Field(None, max_length=500)


def _cache_key(question: str) -> str:
    normalized = re.sub(r"\s+", " ", question.lower()).strip(" ?!.")
    return KVCache.key(settings.ROUTER_MODEL, settings.ANSWER_MODEL, settings.EMBED_MODEL, settings.COLLECTION_NAME,
                PROMPT_FINGERPRINT, normalized)


# ---------------- routes ----------------
@app.get("/", include_in_schema=False)
async def index():
    return {"service": "UNO Rulebook RAG Chatbot API", "health": "/health", "docs": "/docs"}


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "gemini": await run_in_threadpool(gemini_status),
        "llm_model": settings.ANSWER_MODEL,
        "router_model": settings.ROUTER_MODEL,
        "embed_model": settings.EMBED_MODEL,
        "requests_today": usage.today(),
        "daily_request_budget": settings.DAILY_REQUEST_BUDGET,
        "documents_in_collection": collection_count(),
        "langfuse": {
            "enabled": settings.langfuse_enabled,
            "base_url": settings.LANGFUSE_BASE_URL if settings.langfuse_enabled else None,
            "auth_ok": await run_in_threadpool(auth_ok),
        },
    }


@app.post("/ingest", dependencies=[Depends(require_api_key)])
async def ingest_endpoint(req: IngestRequest):
    try:
        return await run_in_threadpool(ingest, req.reset)
    except DailyLimitReached:
        raise HTTPException(status_code=429, detail=DAILY_LIMIT_MESSAGE)
    except Exception as e:
        logger.exception("Ingest failed")
        raise HTTPException(status_code=500, detail=str(e))


def _budget(before: int) -> dict:
    today = usage.today()
    return {"requests_used": today - before, "requests_today": today, "daily_budget": settings.DAILY_REQUEST_BUDGET}


async def _flush_if_serverless() -> None:
    """On Cloud Run (request-based billing) CPU is throttled after the response, so send traces now."""
    if settings.LANGFUSE_FLUSH_EACH_REQUEST:
        await run_in_threadpool(flush)


@app.post("/chat", response_model=ChatResponse, dependencies=[Depends(require_api_key)])
async def chat(req: ChatRequest):
    try:
        return await _chat_turn(req)
    finally:
        await _flush_if_serverless()


async def _chat_turn(req: ChatRequest) -> ChatResponse:
    config: dict = {"configurable": {"thread_id": req.session_id}}
    graph = app.state.graph
    before = usage.today()

    with trace_turn("chat", session_id=req.session_id, user_id=req.visitor, input={"question": req.question}) as turn:
        # First message of a session with a previously answered question: reply from cache (0 requests)
        snapshot = await graph.aget_state(config)
        first_turn = not snapshot.values.get("messages")
        cache_key = _cache_key(req.question)
        if settings.ANSWER_CACHE and first_turn and (hit := app.state.answer_cache.get(cache_key)):
            await graph.aupdate_state(
                config,
                {"messages": [HumanMessage(content=req.question), AIMessage(content=hit["answer"])], "question": req.question},
                as_node="respond_direct",
            )
            turn.finish(output=hit, metadata={"route": "rulebook", "cached": True, **_budget(before)},
                        tags=["cached", "route:rulebook"])
            return ChatResponse(answer=hit["answer"], sources=[Source(**s) for s in hit["sources"]], cached=True,
                                trace_id=turn.trace_id)

        if handler := callback_handler():
            config["callbacks"] = [handler]  # traces graph nodes + every LLM call under this turn
        try:
            result = await graph.ainvoke(
                {"messages": [HumanMessage(content=req.question)], "question": req.question}, config=config
            )
        except DailyLimitReached:
            turn.error(DAILY_LIMIT_MESSAGE, metadata=_budget(before), tags=["daily-limit"])
            raise HTTPException(status_code=429, detail=DAILY_LIMIT_MESSAGE)
        except Exception as e:
            logger.exception("Chat failed")
            turn.error(str(e), metadata=_budget(before), tags=["error"])
            raise HTTPException(status_code=502, detail=f"The AI service failed to answer: {e}")

        seen, sources = set(), []
        for d in result.get("used_documents", []):
            key = (d.metadata.get("source"), d.metadata.get("page"))
            if key not in seen:
                seen.add(key)
                sources.append(Source(source=key[0], page=key[1]))
        answer = result["messages"][-1].content
        route = result.get("route", "rulebook")

        tags = [f"route:{route}"]
        if route == "rulebook" and not result.get("found"):
            tags.append("refused")
        turn.finish(
            output={"answer": answer, "sources": [s.model_dump() for s in sources]},
            metadata={
                "route": route,
                "found": result.get("found"),
                "rewrites": result.get("rewrites", 0),
                "standalone_question": result.get("standalone_question"),
                "cached": False,
                "router_model": settings.ROUTER_MODEL,
                "answer_model": settings.ANSWER_MODEL,
                "embed_model": settings.EMBED_MODEL,
                **_budget(before),
            },
            tags=tags,
        )

        # Only cache real rulebook answers (small talk is cheap; refusals may change after re-ingest)
        if settings.ANSWER_CACHE and first_turn and route == "rulebook" and result.get("found"):
            app.state.answer_cache.set(cache_key, {"answer": answer, "sources": [s.model_dump() for s in sources]})
        return ChatResponse(answer=answer, sources=sources, trace_id=turn.trace_id)


@app.post("/feedback", status_code=204, dependencies=[Depends(require_api_key)])
async def feedback(req: FeedbackRequest):
    """Thumbs up/down from the chat widget, stored as a Langfuse score on the answer's trace."""
    if not settings.langfuse_enabled:
        raise HTTPException(status_code=503, detail="Monitoring is not configured")
    ok = await run_in_threadpool(score, req.trace_id, "user-feedback", 1 if req.value == 1 else 0, "BOOLEAN", req.comment)
    await _flush_if_serverless()
    if not ok:
        raise HTTPException(status_code=502, detail="Could not record feedback")
    return Response(status_code=204)


@app.delete("/chat/{session_id}", dependencies=[Depends(require_api_key)])
async def clear_chat(session_id: str):
    await app.state.graph.checkpointer.adelete_thread(session_id)
    return {"cleared": session_id}


if __name__ == "__main__":
    import uvicorn

    # Cloud Run (and similar platforms) pass the port in $PORT
    uvicorn.run("app.main:app", host=settings.API_HOST, port=int(os.environ.get("PORT", settings.API_PORT)))
