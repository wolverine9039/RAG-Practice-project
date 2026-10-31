# FastAPI backend for the UNO rulebook RAG chatbot (Cloud Run).
# Build context must contain deploy/build/chroma_db (created by deploy/cloudrun/prepare_index.py).
FROM python:3.13-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY app/ app/
COPY Data/ Data/
# Pre-built vector index (Gemini embeddings), so cold starts don't re-embed the PDFs
COPY deploy/build/chroma_db/ chroma_db/

# Run as a non-root user; Chroma and the caches need write access
RUN useradd --create-home --uid 10001 appuser && chown -R appuser:appuser /app
USER appuser

ENV CHROMA_DIR=/app/chroma_db \
    CACHE_DIR=/tmp/uno-cache

EXPOSE 8080
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8080}"]
