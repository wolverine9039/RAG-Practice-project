"""Load PDFs with pdfplumber, chunk them and store them in Chroma.

CLI: python -m app.ingest [--reset]
"""
import argparse
import hashlib
import logging
import re
from pathlib import Path

import pdfplumber
from langchain_core.documents import Document
from langchain_text_splitters import RecursiveCharacterTextSplitter

from app.config import settings
from app.vectorstore import get_vectorstore, invalidate_keyword_index

logger = logging.getLogger(__name__)


CID_RE = re.compile(r"\(cid:\d+\)")
WORD_RE = re.compile(r"[A-Za-z]{3,}")
ALLOWED_PUNCT = set(".,:;!?()'\"-/%+&’“”�")


def _is_readable(line: str) -> bool:
    """Drop lines that are mostly glyph garbage (fonts without a unicode map)."""
    s = line.strip()
    if not s:
        return False
    ok = sum(c.isalnum() or c.isspace() or c in ALLOWED_PUNCT for c in s) / len(s)
    return ok >= 0.8 and WORD_RE.search(s) is not None


def _clean(text: str) -> str:
    text = CID_RE.sub("", text)
    return "\n".join(line for line in text.splitlines() if _is_readable(line))


def _table_to_text(table: list[list[str | None]]) -> str:
    rows = [" | ".join((cell or "").strip() for cell in row) for row in table if row]
    return _clean("\n".join(rows))


def _doc_title(filename: str) -> str:
    """'Uno No mercy.pdf' -> 'Uno No Mercy'."""
    stem = Path(filename).stem.split("-pdf")[0]
    return re.sub(r"[-_]+", " ", stem).strip().title()


def load_pdfs(data_dir: Path) -> list[Document]:
    """Return one Document per non-empty, non-duplicate PDF page (text + tables)."""
    pages: list[Document] = []
    for pdf_path in sorted(data_dir.glob("*.pdf")):
        seen_hashes: set[str] = set()
        try:
            with pdfplumber.open(pdf_path) as pdf:
                for page_no, raw_page in enumerate(pdf.pages, start=1):
                    page = raw_page.dedupe_chars()  # fixes doubled glyphs like "CCaarrd"
                    text = _clean(page.extract_text() or "")
                    tables = [_table_to_text(t) for t in page.extract_tables()]
                    tables = [t for t in tables if t]
                    if tables:
                        text += "\n\nTables:\n" + "\n\n".join(tables)

                    digest = hashlib.md5(text.encode()).hexdigest()
                    if digest in seen_hashes:
                        logger.info("Skipping duplicate page %s p.%d", pdf_path.name, page_no)
                        continue
                    seen_hashes.add(digest)

                    if text.strip():
                        pages.append(
                            Document(
                                page_content=text.strip(),
                                metadata={"source": pdf_path.name, "page": page_no},
                            )
                        )
        except Exception:
            logger.exception("Failed to read %s", pdf_path.name)
    return pages


def ingest(reset: bool = False) -> dict:
    vs = get_vectorstore()
    if reset:
        vs.reset_collection()

    pages = load_pdfs(settings.data_path)
    splitter = RecursiveCharacterTextSplitter(
        chunk_size=settings.CHUNK_SIZE, chunk_overlap=settings.CHUNK_OVERLAP
    )

    chunks: list[Document] = []
    ids: list[str] = []
    for page in pages:
        title = _doc_title(page.metadata["source"])
        for idx, chunk in enumerate(splitter.split_documents([page])):
            # Contextual header so embeddings/LLM know which rulebook a chunk belongs to
            chunk.page_content = f"Rulebook: {title}\n{chunk.page_content}"
            chunk.metadata["chunk"] = idx
            chunk.metadata["title"] = title
            chunks.append(chunk)
            ids.append(f"{page.metadata['source']}:{page.metadata['page']}:{idx}")

    if chunks:
        vs.add_documents(chunks, ids=ids)
    invalidate_keyword_index()

    stats = {
        "files": len({p.metadata["source"] for p in pages}),
        "pages": len(pages),
        "chunks": len(chunks),
        "collection_count": vs._collection.count(),
    }
    logger.info("Ingest complete: %s", stats)
    return stats


if __name__ == "__main__":
    logging.basicConfig(level=settings.LOG_LEVEL)
    parser = argparse.ArgumentParser(description="Ingest PDFs into Chroma")
    parser.add_argument("--reset", action="store_true", help="drop the collection first")
    args = parser.parse_args()
    print(ingest(reset=args.reset))
