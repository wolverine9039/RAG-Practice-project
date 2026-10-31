"""Central settings, loaded from the project's .env file."""
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

PROJECT_ROOT = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=PROJECT_ROOT / ".env", env_file_encoding="utf-8", extra="ignore"
    )

    # Google Gemini on Vertex AI (auth: Application Default Credentials, or a service-account JSON file)
    GOOGLE_CLOUD_PROJECT: str = ""
    GOOGLE_CLOUD_LOCATION: str = "global"
    GOOGLE_APPLICATION_CREDENTIALS: str = ""  # optional path to a service-account key; empty = ADC
    ROUTER_MODEL: str = "gemini-3.5-flash-lite"  # analyze / rewrite step
    ROUTER_THINKING: str = "minimal"  # minimal | low | medium | high
    ANSWER_MODEL: str = "gemini-3.5-flash"  # grounded answer
    ANSWER_THINKING: str = "low"
    LLM_TEMPERATURE: float = 0.1  # ignored by models with fixed sampling (e.g. Flash-Lite)
    LLM_MAX_TOKENS: int = 2000  # includes thinking tokens
    EMBED_MODEL: str = "gemini-embedding-2"
    EMBED_DIMENSIONS: int = 768
    # gemini-embedding-2 ignores task_type; it takes the task as a text prefix instead
    EMBED_QUERY_PREFIX: str = "task: search result | query: "
    EMBED_DOC_PREFIX: str = "title: none | text: "
    EMBED_CONCURRENCY: int = 8  # gemini-embedding-2 embeds one text per request; run several in parallel

    # Usage cap / caching
    DAILY_REQUEST_BUDGET: int = 2000  # safety cap on model requests per UTC day (protects credits)
    ANSWER_CACHE: bool = True
    CACHE_DIR: Path = Path("cache")

    # Langfuse monitoring (disabled unless both keys are set)
    LANGFUSE_PUBLIC_KEY: str = ""
    LANGFUSE_SECRET_KEY: str = ""
    LANGFUSE_BASE_URL: str = "https://cloud.langfuse.com"  # EU; US: https://us.cloud.langfuse.com
    LANGFUSE_ENVIRONMENT: str = "local"
    LANGFUSE_FLUSH_EACH_REQUEST: bool = False  # true on Cloud Run: send traces before the response ends

    # Paths / Chroma
    DATA_DIR: Path = Path("Data")
    CHROMA_DIR: Path = Path("chroma_db")
    COLLECTION_NAME: str = "uno_docs_gemini"

    # Chunking / retrieval
    CHUNK_SIZE: int = 1000
    CHUNK_OVERLAP: int = 150
    TOP_K: int = 6
    MAX_REWRITES: int = 1
    HISTORY_WINDOW: int = 6
    RETRIEVAL_MODE: str = "hybrid"  # hybrid | bm25 (bm25 skips the query-embedding request)

    # API server
    API_HOST: str = "0.0.0.0"
    API_PORT: int = 8000
    BACKEND_API_KEY: str = ""  # if set, /chat and /ingest require header X-API-Key
    AUTO_INGEST_ON_STARTUP: bool = True
    LOG_LEVEL: str = "INFO"

    @property
    def langfuse_enabled(self) -> bool:
        return bool(self.LANGFUSE_PUBLIC_KEY and self.LANGFUSE_SECRET_KEY)

    @property
    def data_path(self) -> Path:
        return self.DATA_DIR if self.DATA_DIR.is_absolute() else PROJECT_ROOT / self.DATA_DIR

    @property
    def chroma_path(self) -> Path:
        return self.CHROMA_DIR if self.CHROMA_DIR.is_absolute() else PROJECT_ROOT / self.CHROMA_DIR

    @property
    def cache_path(self) -> Path:
        path = self.CACHE_DIR if self.CACHE_DIR.is_absolute() else PROJECT_ROOT / self.CACHE_DIR
        path.mkdir(parents=True, exist_ok=True)
        return path

    @property
    def credentials_path(self) -> Path | None:
        if not self.GOOGLE_APPLICATION_CREDENTIALS:
            return None
        path = Path(self.GOOGLE_APPLICATION_CREDENTIALS)
        return path if path.is_absolute() else PROJECT_ROOT / path


settings = Settings()
