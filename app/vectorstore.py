"""Gemini embeddings, persistent Chroma vector store and hybrid (BM25 + vector) search."""
import re
from functools import lru_cache

from langchain_chroma import Chroma
from langchain_core.documents import Document
from rank_bm25 import BM25Okapi

from app.config import settings
from app.llm import GeminiEmbeddings

TOKEN_RE = re.compile(r"[a-z0-9]+")
RRF_K = 60  # standard reciprocal-rank-fusion constant


@lru_cache
def get_embeddings() -> GeminiEmbeddings:
    return GeminiEmbeddings()


@lru_cache
def get_vectorstore() -> Chroma:
    return Chroma(
        collection_name=settings.COLLECTION_NAME,
        embedding_function=get_embeddings(),
        persist_directory=str(settings.chroma_path),
        collection_metadata={"hnsw:space": "cosine"},
    )


def collection_count() -> int:
    return get_vectorstore()._collection.count()


# ---------------- keyword index (rebuilt after every ingest) ----------------
def _tokenize(text: str) -> list[str]:
    return TOKEN_RE.findall(text.lower())


class _KeywordIndex:
    def __init__(self) -> None:
        data = get_vectorstore().get(include=["documents", "metadatas"])
        self.docs = [
            Document(page_content=text, metadata=meta)
            for text, meta in zip(data["documents"], data["metadatas"])
        ]
        self.bm25 = BM25Okapi([_tokenize(d.page_content) for d in self.docs]) if self.docs else None
        # 'Uno No Mercy' -> 'no mercy': lets us detect which rulebook a question is about
        self.aliases: dict[str, str] = {}
        for d in self.docs:
            title = d.metadata.get("title", "")
            alias = re.sub(r"^uno\s*|\s*rules$", "", title.lower()).strip()
            if alias:
                self.aliases[alias] = d.metadata["source"]


_index: _KeywordIndex | None = None


def get_keyword_index() -> _KeywordIndex:
    global _index
    if _index is None:
        _index = _KeywordIndex()
    return _index


def invalidate_keyword_index() -> None:
    global _index
    _index = None


def available_rulebooks() -> list[str]:
    """Titles of all indexed rulebooks, e.g. ['Uno Dare', 'Uno Flip', ...]."""
    return sorted({d.metadata.get("title", d.metadata["source"]) for d in get_keyword_index().docs})


def detect_sources(query: str) -> list[str]:
    """Return the rulebook files explicitly mentioned in the query (e.g. 'UNO Flip')."""
    q = query.lower()
    return sorted(
        {src for alias, src in get_keyword_index().aliases.items() if re.search(rf"\b{re.escape(alias)}\b", q)}
    )


def _doc_key(d: Document) -> tuple:
    return (d.metadata.get("source"), d.metadata.get("page"), d.metadata.get("chunk"))


async def hybrid_search(
    query: str, k: int | None = None, filter_by_title: bool = True, mode: str | None = None
) -> list[Document]:
    """BM25 + vector search fused with reciprocal rank fusion.

    If the question names specific rulebooks, the search is restricted to them.
    mode="bm25" skips the vector search (saves one embedding request on the free tier).
    """
    k = k or settings.TOP_K
    pool = k * 3
    sources = detect_sources(query) if filter_by_title else []
    index = get_keyword_index()

    vec_docs: list[Document] = []
    if (mode or settings.RETRIEVAL_MODE) != "bm25":
        vec_filter = {"source": {"$in": sources}} if sources else None
        vec_docs = await get_vectorstore().asimilarity_search(query, k=pool, filter=vec_filter)

    kw_docs: list[Document] = []
    if index.bm25:
        scores = index.bm25.get_scores(_tokenize(query))
        ranked = sorted(range(len(index.docs)), key=lambda i: -scores[i])
        kw_docs = [
            index.docs[i]
            for i in ranked
            if scores[i] > 0 and (not sources or index.docs[i].metadata["source"] in sources)
        ][:pool]

    fused: dict[tuple, float] = {}
    by_key: dict[tuple, Document] = {}
    for results in (vec_docs, kw_docs):
        for rank, doc in enumerate(results):
            key = _doc_key(doc)
            by_key[key] = doc
            fused[key] = fused.get(key, 0.0) + 1.0 / (RRF_K + rank)

    top = sorted(fused, key=lambda key: -fused[key])[:k]
    return [by_key[key] for key in top]
