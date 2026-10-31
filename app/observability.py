"""Langfuse monitoring. The only module that imports langfuse.

Everything here is a no-op when LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY are not set, and every Langfuse
call is guarded: monitoring problems are logged, never raised into the chat path.
"""
import logging
from contextlib import contextmanager
from functools import lru_cache
from typing import Any, Iterator

from app.config import settings

logger = logging.getLogger(__name__)


@lru_cache
def get_langfuse():
    """The Langfuse client (singleton), or None when monitoring is disabled."""
    if not settings.langfuse_enabled:
        return None
    try:
        from langfuse import Langfuse

        return Langfuse(
            public_key=settings.LANGFUSE_PUBLIC_KEY,
            secret_key=settings.LANGFUSE_SECRET_KEY,
            base_url=settings.LANGFUSE_BASE_URL,
            environment=settings.LANGFUSE_ENVIRONMENT,
        )
    except Exception:
        logger.exception("Langfuse client could not be created; monitoring disabled")
        return None


def callback_handler():
    """LangChain/LangGraph callback that traces graph nodes and LLM calls (new per request)."""
    if get_langfuse() is None:
        return None
    try:
        from langfuse.langchain import CallbackHandler

        return CallbackHandler()
    except Exception:
        logger.exception("Langfuse CallbackHandler unavailable")
        return None


class Turn:
    """Handle on one traced chat turn (no-op when monitoring is disabled)."""

    def __init__(self, span=None) -> None:
        self.span = span
        self.trace_id: str | None = getattr(span, "trace_id", None)

    def finish(self, output: Any = None, metadata: dict | None = None, tags: list[str] | None = None,
               level: str | None = None, status_message: str | None = None) -> None:
        if self.span is None:
            return
        try:
            self.span.update(output=output, metadata=metadata, level=level, status_message=status_message)
            if tags:
                # Trace tags are only known at the end of a turn (route, cache hit...): attach them through a
                # short summary event created inside propagate_attributes.
                from langfuse import propagate_attributes

                with propagate_attributes(tags=tags):
                    self.span.create_event(name="turn-summary", metadata=metadata)
        except Exception:
            logger.warning("Langfuse: could not finish trace", exc_info=True)

    def error(self, message: str, metadata: dict | None = None, tags: list[str] | None = None) -> None:
        self.finish(output={"error": message}, metadata=metadata, tags=tags, level="ERROR", status_message=message)


@contextmanager
def trace_turn(name: str, *, session_id: str | None = None, user_id: str | None = None, input: Any = None,
               tags: list[str] | None = None, environment: str | None = None) -> Iterator[Turn]:
    """Root span for one chat turn; graph nodes, LLM calls and embeddings nest underneath."""
    client = get_langfuse()
    if client is None:
        yield Turn()
        return
    try:
        from langfuse import propagate_attributes

        # Fresh trace id: the turn is always a root observation, even when FastAPI's own OpenTelemetry spans
        # (not exported to Langfuse) are the active context.
        span_cm = client.start_as_current_observation(
            name=name, as_type="chain", input=input, trace_context={"trace_id": client.create_trace_id()}
        )
        span = span_cm.__enter__()
        attrs_cm = propagate_attributes(session_id=session_id, user_id=user_id, trace_name=name, tags=tags,
                                        environment=environment)
        attrs_cm.__enter__()
    except Exception:
        logger.warning("Langfuse: could not start trace", exc_info=True)
        yield Turn()
        return
    try:
        yield Turn(span)
    finally:
        for cm in (attrs_cm, span_cm):
            try:
                cm.__exit__(None, None, None)
            except Exception:
                logger.warning("Langfuse: could not close trace context", exc_info=True)


class _Noop:
    def update(self, **_kwargs) -> None:
        pass


@contextmanager
def trace_embedding(model: str, texts: list[str]) -> Iterator[Any]:
    """Observation around one embedding request (call .update(usage_details=...) afterwards)."""
    client = get_langfuse()
    if client is None:
        yield _Noop()
        return
    try:
        cm = client.start_as_current_observation(
            name="gemini-embedding", as_type="embedding", model=model,
            input={"count": len(texts), "first": texts[0][:300] if texts else ""},
        )
        obs = cm.__enter__()
    except Exception:
        logger.warning("Langfuse: could not start embedding observation", exc_info=True)
        yield _Noop()
        return
    try:
        yield obs
    finally:
        try:
            cm.__exit__(None, None, None)
        except Exception:
            logger.warning("Langfuse: could not close embedding observation", exc_info=True)


def score(trace_id: str, name: str, value: float | str, data_type: str = "NUMERIC", comment: str | None = None) -> bool:
    client = get_langfuse()
    if client is None:
        return False
    try:
        client.create_score(trace_id=trace_id, name=name, value=value, data_type=data_type, comment=comment)
        return True
    except Exception:
        logger.warning("Langfuse: could not create score", exc_info=True)
        return False


def auth_ok() -> bool | None:
    client = get_langfuse()
    if client is None:
        return None
    try:
        return bool(client.auth_check())
    except Exception:
        return False


def flush() -> None:
    client = get_langfuse()
    if client is not None:
        try:
            client.flush()
        except Exception:
            logger.warning("Langfuse: flush failed", exc_info=True)
