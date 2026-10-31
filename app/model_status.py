"""Check the configured Gemini models on Vertex AI and list the Gemini models the project can use.

Metadata calls only (no generation, no cost). Usage:  python -m app.model_status
"""
from app.config import settings
from app.llm import gemini_status, get_genai_client


def main() -> None:
    status = gemini_status()
    print(f"Project {status['project']}  location {status['location']}  auth {status['auth']}")
    print("Configured models:", "OK" if status.get("ok") else f"PROBLEM - {status.get('error')}")
    for role, model in (("router", settings.ROUTER_MODEL), ("answer", settings.ANSWER_MODEL),
                        ("embeddings", settings.EMBED_MODEL)):
        print(f"  {role:<11} {model}")

    configured = {settings.ROUTER_MODEL, settings.ANSWER_MODEL, settings.EMBED_MODEL}
    names = set()
    for m in get_genai_client().models.list():
        name = (getattr(m, "name", "") or "").split("/")[-1]
        if name.startswith("gemini"):
            names.add(name)
    print("\nGemini models available to this project:")
    for name in sorted(names):
        print(f"  {name:<40} {'<- in use' if name in configured else ''}")


if __name__ == "__main__":
    main()
