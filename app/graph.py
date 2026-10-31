"""LangGraph RAG flow (Gemini on Vertex AI: Flash-Lite routes, Flash answers).

analyze ─┬─ chitchat / off_topic -> respond_direct                       (1 request)
         └─ rulebook -> retrieve -> answer ─┬─ found / no retries left   (3 requests)
                                            └─ not found -> rewrite_query -> retrieve (if MAX_REWRITES > 0)
"""
import logging
import re
from typing import Annotated, TypedDict

from langchain_core.documents import Document
from langchain_core.messages import AIMessage, BaseMessage
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages

from app.config import settings
from app.formatting import clean_markdown
from app.llm import call_llm, parse_json
from app.prompts import ANALYZE_PROMPT, ANSWER_PROMPT, NO_CONTEXT_ANSWER, OFF_TOPIC_ANSWER, REWRITE_PROMPT
from app.vectorstore import available_rulebooks, hybrid_search

logger = logging.getLogger(__name__)

ROUTES = ("chitchat", "rulebook", "off_topic")
FOLLOW_UP_RE = re.compile(r"\b(it|its|that|this|they|them|those|these|same)\b|^\s*(and|what about|how about|also)\b", re.I)
DEFAULT_GREETING = "Hi! Ask me anything about the UNO rulebooks and I'll look it up for you."


class RAGState(TypedDict):
    messages: Annotated[list[BaseMessage], add_messages]
    question: str
    route: str  # "chitchat" | "rulebook" | "off_topic"
    reply: str  # small-talk reply produced by analyze
    standalone_question: str  # question rewritten without chat history (never changes)
    search_query: str  # what we send to the retriever (may be rewritten)
    documents: list[Document]  # retrieved chunks
    used_documents: list[Document]  # chunks the answer actually used (-> sources)
    found: bool
    rewrites: int


def _history(state: RAGState) -> list[BaseMessage]:
    """Previous turns only (the latest human message is excluded)."""
    return state["messages"][:-1][-settings.HISTORY_WINDOW :]


def _history_text(history: list[BaseMessage]) -> str:
    if not history:
        return "(none)"
    return "\n".join(f"{'User' if m.type == 'human' else 'Assistant'}: {m.content[:300]}" for m in history)


# ---------------- nodes ----------------
async def analyze(state: RAGState) -> dict:
    """One LLM call: route the message, make it standalone, and draft a small-talk reply."""
    history = _history(state)
    question = state["question"]
    raw = await call_llm(
        ANALYZE_PROMPT.format_messages(
            rulebooks=", ".join(available_rulebooks()) or "UNO rulebooks",
            history=_history_text(history),
            question=question,
        ),
        role="router",
    )
    data = parse_json(raw) or {}
    route = str(data.get("route", "")).lower().strip()
    if route not in ROUTES:
        route = "rulebook"  # safe default: try to answer from the rulebooks
    standalone = str(data.get("standalone_question") or "").strip() or question
    last_user = next((m.content for m in reversed(history) if m.type == "human"), "")
    # Guard: models sometimes answer instead of rewriting -> fall back
    if len(standalone) > len(question) + 200:
        standalone = f"{last_user} {question}".strip()
    # Guard: small fallback models sometimes leave an obvious follow-up unrewritten ("how many points is it worth?")
    elif last_user and standalone.lower() == question.lower() and FOLLOW_UP_RE.search(question):
        standalone = f"{question} (previous question: {last_user})"
    logger.info("route=%s standalone=%r", route, standalone)
    return {
        "route": route,
        "reply": clean_markdown(str(data.get("reply") or "")),
        "standalone_question": standalone,
        "search_query": standalone,
        "documents": [],
        "used_documents": [],  # clear so this turn never reports the previous turn's sources
        "found": False,
        "rewrites": 0,
    }


async def respond_direct(state: RAGState) -> dict:
    text = (state["reply"] or DEFAULT_GREETING) if state["route"] == "chitchat" else OFF_TOPIC_ANSWER
    return {"messages": [AIMessage(content=text)]}


async def retrieve(state: RAGState) -> dict:
    # Include the standalone question so a rewrite can never drop the rulebook name
    query = state["search_query"]
    if query != state["standalone_question"]:
        query = f"{query} ({state['standalone_question']})"
    return {"documents": await hybrid_search(query)}


async def answer(state: RAGState) -> dict:
    """One LLM call: pick the relevant passages and answer from them (grader + generator)."""
    docs = state["documents"]
    can_retry = state["rewrites"] < settings.MAX_REWRITES
    if docs:
        context = "\n\n".join(
            f"[{i}] ({d.metadata.get('source')} p.{d.metadata.get('page')})\n{d.page_content}"
            for i, d in enumerate(docs, start=1)
        )
        raw = await call_llm(ANSWER_PROMPT.format_messages(context=context, question=state["standalone_question"]),
                             role="answer")
        data = parse_json(raw)
        if data is None:  # model ignored the JSON format: use its text as the answer
            data = {"found": bool(raw) and "couldn't find" not in raw.lower(), "answer": raw, "used": []}
        found = bool(data.get("found")) and bool(str(data.get("answer") or "").strip())
        if found:
            used = []
            for n in data.get("used") or []:
                try:
                    if 1 <= int(n) <= len(docs) and docs[int(n) - 1] not in used:
                        used.append(docs[int(n) - 1])
                except (TypeError, ValueError):
                    continue
            logger.info("answer found; used %d/%d passages", len(used), len(docs))
            return {
                "found": True,
                "used_documents": used or docs,
                "messages": [AIMessage(content=clean_markdown(str(data["answer"])))],
            }
    logger.info("no answer in %d passages (rewrites=%d)", len(docs), state["rewrites"])
    if can_retry:
        return {"found": False}
    return {"found": False, "used_documents": [], "messages": [AIMessage(content=NO_CONTEXT_ANSWER)]}


async def rewrite_query(state: RAGState) -> dict:
    query = (await call_llm(REWRITE_PROMPT.format_messages(question=state["search_query"]),
                            role="router", json_mode=False)).strip()
    logger.info("rewritten query=%r", query)
    return {"search_query": query or state["search_query"], "rewrites": state["rewrites"] + 1}


# ---------------- edges ----------------
def route_after_analyze(state: RAGState) -> str:
    return "retrieve" if state["route"] == "rulebook" else "respond_direct"


def route_after_answer(state: RAGState) -> str:
    if not state["found"] and state["rewrites"] < settings.MAX_REWRITES:
        return "rewrite_query"
    return END


def build_graph():
    g = StateGraph(RAGState)
    g.add_node("analyze", analyze)
    g.add_node("respond_direct", respond_direct)
    g.add_node("retrieve", retrieve)
    g.add_node("answer", answer)
    g.add_node("rewrite_query", rewrite_query)

    g.add_edge(START, "analyze")
    g.add_conditional_edges("analyze", route_after_analyze, {"retrieve": "retrieve", "respond_direct": "respond_direct"})
    g.add_edge("respond_direct", END)
    g.add_edge("retrieve", "answer")
    g.add_conditional_edges("answer", route_after_answer, {"rewrite_query": "rewrite_query", END: END})
    g.add_edge("rewrite_query", "retrieve")

    return g.compile(checkpointer=MemorySaver())
