"""Evaluate the RAG chatbot and write eval/results_gemini.json.

Respects the daily request cap (DAILY_REQUEST_BUDGET):
  python -m eval.run_eval --retrieval-only        # ~31 embedding requests on first run, 0 once cached
  python -m eval.run_eval --limit 5               # end-to-end on the first 5 questions of each group
  python -m eval.run_eval                         # full end-to-end (~110 requests, a few cents on Gemini)
  python -m eval.run_eval --backend-url https://<service>.run.app
                                                  # same questions against the deployed API over HTTPS
                                                  # (X-API-Key from .env) -> eval/results_production.json
Results from separate runs are merged into the same JSON file. The first (Ollama) baseline is archived in
docs/archive/eval_results_v1_ollama.json.

With Langfuse keys set, rulebook questions also run as a Langfuse experiment on the dataset "uno-rulebook-qa"
(scores: answer_correct, citation_correct, route_correct, requests_used), other turns are traced with
environment "eval", and retrieval runs are logged as an "eval-retrieval" trace with one score per metric.
"""
import argparse
import asyncio
import json
import logging
import re
import statistics
import time
import uuid
from urllib.parse import urlparse

import httpx
from langchain_core.messages import HumanMessage

from app import graph as G
from app.config import PROJECT_ROOT, settings
from app import llm as L
from app import vectorstore as V
from app.llm import DailyLimitReached, usage
from app.observability import callback_handler, flush, get_langfuse, score, trace_turn
from app.prompts import NO_CONTEXT_ANSWER, OFF_TOPIC_ANSWER
from app.vectorstore import _tokenize, get_keyword_index, get_vectorstore, hybrid_search
from eval.dataset import CHITCHAT, FOLLOW_UPS, OFF_TOPIC, RAG_QUESTIONS

logging.basicConfig(level=logging.WARNING)
OUT = PROJECT_ROOT / "eval" / "results_gemini.json"
OUT_PROD = PROJECT_ROOT / "eval" / "results_production.json"
K = settings.TOP_K


# ---------------- helpers ----------------
def _alt_match(text: str, alt: str) -> bool:
    t, a = text.lower(), alt.lower()
    if re.fullmatch(r"[\d,+]+", a):  # numbers: don't let "5" match "50"
        return re.search(rf"(?<!\d){re.escape(a)}(?!\d)", t) is not None
    return a in t


def answer_ok(text: str, groups: list[list[str]]) -> bool:
    return all(any(_alt_match(text, alt) for alt in group) for group in groups)


def is_gold(doc, item) -> bool:
    content = doc.page_content.lower()
    return doc.metadata["source"] in item["sources"] and any(e in content for e in item["evidence"].split("|"))


def is_refusal(answer: str) -> bool:
    a = answer.lower()
    return answer in (NO_CONTEXT_ANSWER, OFF_TOPIC_ANSWER) or "couldn't find" in a or "can only help" in a


def pct(x: float) -> float:
    return round(100 * x, 1)


def lat(values: list[float]) -> dict:
    if not values:
        return {}
    v = sorted(values)
    return {"mean_s": round(statistics.mean(v), 2), "p50_s": round(statistics.median(v), 2),
            "p95_s": round(v[min(len(v) - 1, int(0.95 * len(v)))], 2), "max_s": round(v[-1], 2)}


# ---------------- retrieval ----------------
async def r_vector(q):
    return await get_vectorstore().asimilarity_search(q, k=K)


async def r_bm25(q):
    idx = get_keyword_index()
    scores = idx.bm25.get_scores(_tokenize(q))
    ranked = sorted(range(len(idx.docs)), key=lambda i: -scores[i])
    return [idx.docs[i] for i in ranked if scores[i] > 0][:K]


async def r_hybrid(q):
    return await hybrid_search(q, K, filter_by_title=False, mode="hybrid")


async def r_bm25_filter(q):
    return await hybrid_search(q, K, mode="bm25")


async def r_hybrid_filter(q):
    return await hybrid_search(q, K, mode="hybrid")


METHODS = {"vector_only": r_vector, "bm25_only": r_bm25, "hybrid_rrf": r_hybrid,
           "bm25_title_filter": r_bm25_filter, "hybrid_rrf_title_filter (production)": r_hybrid_filter}


def _first(docs, pred):
    return next((i + 1 for i, d in enumerate(docs) if pred(d)), None)


async def retrieval_eval() -> dict:
    results = {}
    for name, fn in METHODS.items():
        rows = []
        for item in RAG_QUESTIONS:
            t0 = time.perf_counter()
            docs = await fn(item["q"])  # query embeddings are cached after the first method
            rows.append({
                "src_rank": _first(docs, lambda d: d.metadata["source"] in item["sources"]),
                "gold_rank": _first(docs, lambda d: is_gold(d, item)),
                "src_precision": sum(d.metadata["source"] in item["sources"] for d in docs) / max(len(docs), 1),
                "ms": (time.perf_counter() - t0) * 1000,
            })
        n = len(rows)

        def hit(key, k):
            return pct(sum(1 for r in rows if r[key] and r[key] <= k) / n)

        results[name] = {
            "source_hit@1": hit("src_rank", 1), "source_hit@3": hit("src_rank", 3), f"source_hit@{K}": hit("src_rank", K),
            "source_precision@k": pct(statistics.mean(r["src_precision"] for r in rows)),
            "context_recall@1": hit("gold_rank", 1), "context_recall@3": hit("gold_rank", 3),
            f"context_recall@{K}": hit("gold_rank", K),
            "mrr_gold": round(statistics.mean(1 / r["gold_rank"] if r["gold_rank"] else 0 for r in rows), 3),
            "avg_latency_ms": round(statistics.mean(r["ms"] for r in rows), 1),
        }
        print(f"  {name}: recall@{K}={results[name][f'context_recall@{K}']}%  hit@1={results[name]['source_hit@1']}%")
    return results


# ---------------- end to end ----------------
DATASET = "uno-rulebook-qa"


def reset_clients() -> None:
    """Async HTTP clients are bound to the event loop that first used them; rebuild them between phases."""
    L.get_chat_model.cache_clear()
    L.reset_genai_client()
    V.get_embeddings.cache_clear()
    V.get_vectorstore.cache_clear()
    V.invalidate_keyword_index()


async def run_turn(app, question: str, thread: str, trace: bool = True) -> dict:
    """One graph turn. trace=True wraps it in its own Langfuse trace (environment "eval")."""
    before = usage.today()
    t0 = time.perf_counter()
    config: dict = {"configurable": {"thread_id": thread}}
    if handler := callback_handler():
        config["callbacks"] = [handler]
    payload = {"messages": [HumanMessage(content=question)], "question": question}
    if trace:
        with trace_turn("eval-chat", session_id=thread, input={"question": question}, environment="eval") as turn:
            r = await app.ainvoke(payload, config=config)
            turn.finish(output={"answer": r["messages"][-1].content},
                        metadata={"route": r.get("route"), "requests_used": usage.today() - before},
                        tags=["eval", f"route:{r.get('route')}"])
    else:  # already inside a Langfuse experiment item trace
        r = await app.ainvoke(payload, config=config)
    return {"answer": r["messages"][-1].content, "route": r.get("route"),
            "sources": sorted({d.metadata["source"] for d in r.get("used_documents", [])}),
            "rewrites": r.get("rewrites", 0), "requests": usage.today() - before,
            "total_s": time.perf_counter() - t0}


def score_rag(item: dict, r: dict) -> dict:
    r.update(q=item["q"], correct=answer_ok(r["answer"], item["answer"]),
             route_ok=r["route"] == "rulebook", cited_ok=any(s in item["sources"] for s in r["sources"]),
             refused=is_refusal(r["answer"]), markdown="**" in r["answer"])
    print(f"  [{'OK ' if r['correct'] else 'BAD'}] {r['requests']} req {r['total_s']:.1f}s {item['q']}")
    return r


def sync_dataset(questions: list[dict]) -> list:
    """Create/refresh the Langfuse dataset from eval/dataset.py (stable item ids, so re-runs upsert)."""
    lf = get_langfuse()
    try:
        lf.get_dataset(DATASET)
    except Exception:
        lf.create_dataset(name=DATASET, description="UNO rulebook questions with required facts (eval/dataset.py)")
    for i, item in enumerate(RAG_QUESTIONS):
        lf.create_dataset_item(
            dataset_name=DATASET, id=f"uno-rag-{i:02d}",
            input={"question": item["q"]},
            expected_output={"required_facts": item["answer"], "sources": item["sources"]},
            metadata={"evidence": item["evidence"]},
        )
    wanted = {q["q"] for q in questions}
    return [it for it in lf.get_dataset(DATASET).items if (it.input or {}).get("question") in wanted]


def rag_experiment(questions: list[dict]) -> list[dict]:
    """Rulebook questions as a Langfuse experiment run (sync: the SDK runs its own event loop)."""
    from langfuse import Evaluation

    by_q = {q["q"]: q for q in questions}
    rows: list[dict] = []
    app = G.build_graph()

    async def task(*, item, **_):
        q = by_q[item.input["question"]]
        r = score_rag(q, await run_turn(app, q["q"], str(uuid.uuid4()), trace=False))
        rows.append(r)
        return r

    def evaluator(*, output, **_):
        if not isinstance(output, dict):
            return []
        return [
            Evaluation(name="answer_correct", value=bool(output["correct"]), data_type="BOOLEAN"),
            Evaluation(name="citation_correct", value=bool(output["cited_ok"]), data_type="BOOLEAN"),
            Evaluation(name="route_correct", value=bool(output["route_ok"]), data_type="BOOLEAN"),
            Evaluation(name="requests_used", value=float(output["requests"]), data_type="NUMERIC"),
        ]

    items = sync_dataset(questions)
    if not items:
        return []
    result = get_langfuse().get_dataset(DATASET).run_experiment(
        name=DATASET,
        run_name=f"e2e-{time.strftime('%Y%m%d-%H%M')}-{settings.ANSWER_MODEL}",
        description="End-to-end rulebook questions (eval/run_eval.py)",
        task=task, evaluators=[evaluator], max_concurrency=1,
        metadata={"router_model": settings.ROUTER_MODEL, "answer_model": settings.ANSWER_MODEL,
                  "embed_model": settings.EMBED_MODEL, "limit": str(len(questions))},
    )
    print("  Langfuse experiment:", getattr(result, "experiment_url", None) or "logged")
    order = [q["q"] for q in questions]
    return sorted(rows, key=lambda r: order.index(r["q"]))


async def rag_local(questions: list[dict]) -> list[dict]:
    app = G.build_graph()
    rows = []
    try:
        for item in questions:
            rows.append(score_rag(item, await run_turn(app, item["q"], str(uuid.uuid4()))))
    except DailyLimitReached:
        print("  Daily request budget reached - saving partial results.")
    return rows


async def other_groups(limit: int | None) -> dict[str, list]:
    app = G.build_graph()
    groups: dict[str, list] = {"off_topic": [], "chitchat": [], "follow_ups": []}
    sel = (lambda xs: xs[:limit]) if limit else (lambda xs: xs)
    try:
        for q in sel(OFF_TOPIC):
            r = await run_turn(app, q, str(uuid.uuid4()))
            r.update(q=q, correct=is_refusal(r["answer"]) and not r["sources"], route_ok=r["route"] == "off_topic")
            groups["off_topic"].append(r)
            print(f"  [{'OK ' if r['correct'] else 'BAD'}] off-topic {r['requests']} req {q}")
        for q in sel(CHITCHAT):
            r = await run_turn(app, q, str(uuid.uuid4()))
            r.update(q=q, correct=r["route"] == "chitchat" and not r["sources"], route_ok=r["route"] == "chitchat")
            groups["chitchat"].append(r)
            print(f"  [{'OK ' if r['correct'] else 'BAD'}] chitchat {r['requests']} req {q}")
        for f in sel(FOLLOW_UPS):
            thread = str(uuid.uuid4())
            first = await run_turn(app, f["turns"][0], thread)
            r = await run_turn(app, f["turns"][1], thread)
            r.update(q=" -> ".join(f["turns"]), correct=answer_ok(r["answer"], f["answer"]),
                     cited_ok=any(s in f["sources"] for s in r["sources"]), route_ok=r["route"] == "rulebook")
            r["requests"] += first["requests"]
            groups["follow_ups"].append(r)
            print(f"  [{'OK ' if r['correct'] else 'BAD'}] follow-up {r['q']}")
    except DailyLimitReached:
        print("  Daily request budget reached - saving partial results.")
    return groups


def e2e_eval(limit: int | None) -> dict:
    questions = RAG_QUESTIONS[:limit] if limit else RAG_QUESTIONS
    reset_clients()
    rag = rag_experiment(questions) if get_langfuse() is not None else asyncio.run(rag_local(questions))
    reset_clients()
    groups = {"rag": rag, **asyncio.run(other_groups(limit))}

    def summary(rows, extra=None):
        if not rows:
            return {"n": 0}
        s = {"n": len(rows), "accuracy": pct(sum(r["correct"] for r in rows) / len(rows)),
             "route_accuracy": pct(sum(r["route_ok"] for r in rows) / len(rows)),
             "avg_requests": round(statistics.mean(r["requests"] for r in rows), 2),
             "latency": lat([r["total_s"] for r in rows])}
        s.update(extra or {})
        return s

    return {
        "rag": summary(rag, {
            "citation_accuracy": pct(sum(r["cited_ok"] for r in rag) / len(rag)) if rag else None,
            "false_refusals": sum(r["refused"] for r in rag),
            "answers_with_markdown": sum(r["markdown"] for r in rag),
        }),
        "off_topic": summary(groups["off_topic"]),
        "chitchat": summary(groups["chitchat"]),
        "follow_ups": summary(groups["follow_ups"]),
        "details": [{k: r[k] for k in ("q", "correct", "route", "sources", "requests", "total_s", "answer")}
                    for rows in groups.values() for r in rows],
    }


# ---------------- deployed backend ----------------
class _BudgetReached(Exception):
    pass


def production_eval(base_url: str, limit: int | None) -> dict:
    """Ask the deployed /chat endpoint the same questions over HTTPS (visitor "eval-prod" in Langfuse).

    Routes and request counts are internal to the backend, so only answers, sources and latency are scored.
    """
    base_url = base_url.rstrip("/")
    sel = (lambda xs: xs[:limit]) if limit else (lambda xs: xs)
    client = httpx.Client(timeout=120, headers={"X-API-Key": settings.BACKEND_API_KEY})

    def ask(question: str, session: str) -> dict:
        t0 = time.perf_counter()
        resp = client.post(f"{base_url}/chat", json={"question": question, "session_id": session, "visitor": "eval-prod"})
        if resp.status_code == 429:
            raise _BudgetReached(resp.text)
        resp.raise_for_status()
        data = resp.json()
        return {"answer": data["answer"], "sources": sorted({s["source"] for s in data["sources"]}),
                "cached": data.get("cached", False), "total_s": time.perf_counter() - t0}

    t0 = time.perf_counter()
    health = client.get(f"{base_url}/health").json()
    health_s = time.perf_counter() - t0
    print(f"  /health {health_s:.1f}s, {health.get('documents_in_collection')} chunks, model {health.get('llm_model')}")
    groups: dict[str, list] = {"rag": [], "off_topic": [], "chitchat": [], "follow_ups": []}
    try:
        for item in sel(RAG_QUESTIONS):
            r = ask(item["q"], str(uuid.uuid4()))
            r.update(q=item["q"], correct=answer_ok(r["answer"], item["answer"]),
                     cited_ok=any(s in item["sources"] for s in r["sources"]), refused=is_refusal(r["answer"]))
            groups["rag"].append(r)
            print(f"  [{'OK ' if r['correct'] else 'BAD'}] {r['total_s']:.1f}s {item['q']}")
        for q in sel(OFF_TOPIC):
            r = ask(q, str(uuid.uuid4()))
            r.update(q=q, correct=is_refusal(r["answer"]) and not r["sources"])
            groups["off_topic"].append(r)
            print(f"  [{'OK ' if r['correct'] else 'BAD'}] off-topic {r['total_s']:.1f}s {q}")
        for q in sel(CHITCHAT):
            r = ask(q, str(uuid.uuid4()))
            r.update(q=q, correct=not r["sources"] and r["answer"] not in (NO_CONTEXT_ANSWER, OFF_TOPIC_ANSWER))
            groups["chitchat"].append(r)
            print(f"  [{'OK ' if r['correct'] else 'BAD'}] chitchat {r['total_s']:.1f}s {q}")
        for f in sel(FOLLOW_UPS):
            session = str(uuid.uuid4())
            ask(f["turns"][0], session)
            r = ask(f["turns"][1], session)
            r.update(q=" -> ".join(f["turns"]), correct=answer_ok(r["answer"], f["answer"]),
                     cited_ok=any(s in f["sources"] for s in r["sources"]))
            groups["follow_ups"].append(r)
            print(f"  [{'OK ' if r['correct'] else 'BAD'}] follow-up {r['total_s']:.1f}s {r['q']}")
    except _BudgetReached as e:
        print("  Backend daily budget reached - saving partial results:", e)

    def summary(rows, extra=None):
        if not rows:
            return {"n": 0}
        s = {"n": len(rows), "accuracy": pct(sum(r["correct"] for r in rows) / len(rows)),
             "cached": sum(r["cached"] for r in rows), "latency": lat([r["total_s"] for r in rows])}
        s.update(extra or {})
        return s

    rag = groups["rag"]
    all_rows = [r for rows in groups.values() for r in rows]
    return {
        "run_at": time.strftime("%Y-%m-%d %H:%M"),
        "backend_host": urlparse(base_url).netloc,
        "limit": limit,
        "health": {"latency_s": round(health_s, 2), "documents_in_collection": health.get("documents_in_collection"),
                   "llm_model": health.get("llm_model"), "router_model": health.get("router_model"),
                   "embed_model": health.get("embed_model")},
        "first_chat_s": round(all_rows[0]["total_s"], 2) if all_rows else None,
        "rag": summary(rag, {
            "citation_accuracy": pct(sum(r["cited_ok"] for r in rag) / len(rag)) if rag else None,
            "false_refusals": sum(r["refused"] for r in rag),
        }),
        "off_topic": summary(groups["off_topic"]),
        "chitchat": summary(groups["chitchat"]),
        "follow_ups": summary(groups["follow_ups"]),
        "all_latency": lat([r["total_s"] for r in all_rows if not r["cached"]]),
        "details": [{k: r[k] for k in ("q", "correct", "sources", "cached", "total_s", "answer")} for r in all_rows],
    }


def log_retrieval(metrics: dict) -> None:
    """One Langfuse trace per retrieval evaluation, with a NUMERIC score per method and metric."""
    with trace_turn("eval-retrieval", input={"questions": len(RAG_QUESTIONS), "top_k": K},
                    environment="eval") as turn:
        turn.finish(output=metrics, metadata={"embed_model": settings.EMBED_MODEL}, tags=["eval", "retrieval"])
    if turn.trace_id:
        for method, m in metrics.items():
            short = method.split(" ")[0]
            for metric in (f"context_recall@{K}", "source_hit@1", "mrr_gold"):
                score(turn.trace_id, f"{short}:{metric}", float(m[metric]), "NUMERIC")


def main():
    parser = argparse.ArgumentParser(description="Evaluate the RAG chatbot (Gemini)")
    parser.add_argument("--retrieval-only", action="store_true", help="only retrieval metrics (embedding requests only)")
    parser.add_argument("--limit", type=int, default=None, help="max questions per end-to-end group")
    parser.add_argument("--backend-url", help="evaluate the deployed API at this URL instead of the local graph")
    args = parser.parse_args()

    if args.backend_url:
        print(f"Production end to end against {urlparse(args.backend_url).netloc}")
        result = production_eval(args.backend_url, args.limit)
        OUT_PROD.write_text(json.dumps(result, indent=2, default=str), encoding="utf-8")
        print(f"RAG accuracy {result['rag'].get('accuracy')}%, latency {result['all_latency']}. Saved {OUT_PROD}")
        return

    results = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {}
    results["config"] = {k: str(v) for k, v in settings.model_dump().items() if "KEY" not in k}
    start_requests = usage.today()
    print(f"Requests used today before run: {start_requests}/{settings.DAILY_REQUEST_BUDGET}")
    print(f"Langfuse: {'on' if get_langfuse() is not None else 'off'}")
    try:
        print("Retrieval")
        results["retrieval"] = asyncio.run(retrieval_eval())
        results["retrieval_run_at"] = time.strftime("%Y-%m-%d %H:%M")
        log_retrieval(results["retrieval"])
    except DailyLimitReached:
        print("  Daily request budget reached during retrieval evaluation.")
    if not args.retrieval_only:
        print("End to end")
        results["e2e"] = e2e_eval(args.limit)
        results["e2e_run_at"] = time.strftime("%Y-%m-%d %H:%M")
        results["e2e_limit"] = args.limit
    OUT.write_text(json.dumps(results, indent=2, default=str), encoding="utf-8")
    flush()
    print(f"Requests used by this run: {usage.today() - start_requests}. Saved {OUT}")


if __name__ == "__main__":
    main()
