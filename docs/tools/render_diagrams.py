"""Render docs/diagrams/*.mmd (Mermaid) to PNG with the local mermaid package in headless Chrome.

Requirements (documentation tooling only, not needed by the app):
    cd docs/tools && npm install          # mermaid + docx
    pip install playwright                # uses the installed Google Chrome (channel="chrome")
Usage:
    python docs/tools/render_diagrams.py              # all diagrams
    python docs/tools/render_diagrams.py 06_chat      # only names containing "06_chat"
"""
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

TOOLS = Path(__file__).resolve().parent
DIAGRAMS = TOOLS.parent / "diagrams"
MERMAID_JS = TOOLS / "node_modules" / "mermaid" / "dist" / "mermaid.min.js"

CONFIG = {
    "startOnLoad": False,
    "theme": "base",
    "securityLevel": "strict",
    "fontFamily": "Segoe UI, Arial, sans-serif",
    "flowchart": {"useMaxWidth": False, "wrappingWidth": 420, "htmlLabels": True, "curve": "basis", "padding": 14, "nodeSpacing": 34, "rankSpacing": 46},
    "sequence": {"useMaxWidth": False, "mirrorActors": False, "messageMargin": 28, "boxMargin": 8},
    "themeVariables": {
        "fontSize": "15px",
        "primaryColor": "#e8f1fb", "primaryBorderColor": "#2a78d6", "primaryTextColor": "#0b0b0b",
        "secondaryColor": "#fdeee7", "tertiaryColor": "#f7f7f5",
        "lineColor": "#52514e", "textColor": "#0b0b0b",
        "clusterBkg": "#f7f7f5", "clusterBorder": "#b9b8b3",
        "edgeLabelBackground": "#ffffff",
        "actorBkg": "#e8f1fb", "actorBorder": "#2a78d6", "signalColor": "#52514e",
        "noteBkgColor": "#fdeee7", "noteBorderColor": "#eb6834",
        "labelBoxBkgColor": "#fdeee7", "labelBoxBorderColor": "#eb6834",
        "activationBkgColor": "#fdeee7",
    },
}

PAGE = """<!doctype html><html><head><meta charset="utf-8">
<style>body{margin:0;background:#fff} #out{display:inline-block;padding:18px;background:#fff}</style>
</head><body><div id="out"></div></body></html>"""


def main() -> None:
    only = sys.argv[1] if len(sys.argv) > 1 else ""
    files = sorted(p for p in DIAGRAMS.glob("*.mmd") if only in p.stem)
    if not MERMAID_JS.exists():
        sys.exit("mermaid not installed: run `npm install` in docs/tools")
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=True)
        page = browser.new_page(device_scale_factor=2, viewport={"width": 1800, "height": 1200})
        page.set_content(PAGE)
        page.add_script_tag(path=str(MERMAID_JS))
        page.evaluate("cfg => mermaid.initialize(cfg)", CONFIG)
        for f in files:
            svg = page.evaluate(
                "async ([id, text]) => (await mermaid.render(id, text)).svg",
                ["d" + f.stem.replace("-", "_"), f.read_text(encoding="utf-8")],
            )
            page.evaluate("svg => { document.getElementById('out').innerHTML = svg; }", svg)
            out = f.with_suffix(".png")
            page.locator("#out").screenshot(path=str(out))
            box = page.locator("#out").bounding_box()
            print(f"{out.name}: {int(box['width'])}x{int(box['height'])} css px")
        browser.close()


if __name__ == "__main__":
    main()
