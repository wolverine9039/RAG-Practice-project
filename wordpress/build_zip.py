"""Package the WordPress plugin as dist/uno-rag-chatbot.zip (upload via Plugins > Add New > Upload).

Run from the project root:  python wordpress/build_zip.py
"""
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PLUGIN = ROOT / "wordpress" / "uno-rag-chatbot"
OUT = ROOT / "dist" / "uno-rag-chatbot.zip"


def main() -> None:
    OUT.parent.mkdir(exist_ok=True)
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(PLUGIN.rglob("*")):
            if path.is_file() and not path.name.startswith("."):
                zf.write(path, Path("uno-rag-chatbot") / path.relative_to(PLUGIN))
    with zipfile.ZipFile(OUT) as zf:
        names = zf.namelist()
    print(f"Wrote {OUT} ({OUT.stat().st_size / 1024:.1f} KB)")
    for name in names:
        print("  ", name)


if __name__ == "__main__":
    main()
