"""Write deploy/cloudrun/env.generated.yaml (Cloud Run --env-vars-file) from the local .env.

Keeps the app settings, overrides the ones that differ on Cloud Run and drops local-only keys.
The file contains secrets (BACKEND_API_KEY, Langfuse keys): deploy.ps1 deletes it after deploying.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from app.config import Settings  # noqa: E402

OUT = Path(__file__).with_name("env.generated.yaml")

DROP = {"GOOGLE_APPLICATION_CREDENTIALS", "API_HOST", "API_PORT", "CHROMA_DIR", "CACHE_DIR", "DATA_DIR", "LOG_LEVEL"}
OVERRIDE = {
    "CACHE_DIR": "/tmp/uno-cache",
    "CHROMA_DIR": "/app/chroma_db",
    "LANGFUSE_ENVIRONMENT": "production",
    "LANGFUSE_FLUSH_EACH_REQUEST": "true",
    "AUTO_INGEST_ON_STARTUP": "true",
    "LOG_LEVEL": "INFO",
}


def main() -> None:
    s = Settings()
    if not s.GOOGLE_CLOUD_PROJECT:
        sys.exit("GOOGLE_CLOUD_PROJECT is empty in .env")
    if not s.BACKEND_API_KEY:
        sys.exit("BACKEND_API_KEY is empty in .env - the public Cloud Run URL would be unprotected")
    values = {k: v for k, v in s.model_dump().items() if k not in DROP}
    values.update(OVERRIDE)
    lines = []
    for key in sorted(values):
        v = values[key]
        if isinstance(v, bool):
            v = "true" if v else "false"
        lines.append(f"{key}: {json.dumps(str(v))}")  # JSON strings are valid YAML scalars (safe for ':' and '|')
    OUT.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Wrote {OUT.name} with {len(lines)} variables")


if __name__ == "__main__":
    main()
