"""Copy the live Gemini collection into a clean Chroma folder that is baked into the Cloud Run image.

Reads ids, documents, metadata and existing embeddings from the local chroma_db (no embedding requests) and writes
only that collection to deploy/build/chroma_db. Run from the project root:
    .venv\\Scripts\\python deploy\\cloudrun\\prepare_index.py
"""
import shutil
import sys
from pathlib import Path

import chromadb

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from app.config import settings  # noqa: E402

OUT = ROOT / "deploy" / "build" / "chroma_db"


def main() -> None:
    src = chromadb.PersistentClient(path=str(settings.chroma_path)).get_collection(settings.COLLECTION_NAME)
    data = src.get(include=["documents", "metadatas", "embeddings"])
    n = len(data["ids"])
    if n == 0:
        sys.exit(f"Collection {settings.COLLECTION_NAME} is empty - run `python -m app.ingest --reset` first.")
    dims = len(data["embeddings"][0])
    if dims != settings.EMBED_DIMENSIONS:
        sys.exit(f"Embedding dimension {dims} != EMBED_DIMENSIONS {settings.EMBED_DIMENSIONS}; re-run ingest.")

    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)
    dst = chromadb.PersistentClient(path=str(OUT)).create_collection(
        settings.COLLECTION_NAME, metadata={"hnsw:space": "cosine"}
    )
    dst.add(ids=data["ids"], documents=data["documents"], metadatas=data["metadatas"],
            embeddings=[list(map(float, e)) for e in data["embeddings"]])
    assert dst.count() == n
    size = sum(p.stat().st_size for p in OUT.rglob("*") if p.is_file()) / 1024 / 1024
    print(f"Wrote {n} chunks ({dims}-d) of '{settings.COLLECTION_NAME}' to {OUT} ({size:.1f} MB)")


if __name__ == "__main__":
    main()
