"""Turn LLM markdown into clean plain text for the chat UI."""
import re

_RULES: list[tuple[re.Pattern, str]] = [
    (re.compile(r"```[a-zA-Z]*\n?|```"), ""),  # code fences
    (re.compile(r"`([^`\n]+)`"), r"\1"),  # inline code
    (re.compile(r"\[([^\]\n]+)\]\((?:https?://|/)[^)\s]+\)"), r"\1"),  # [text](url)
    (re.compile(r"^\s{0,3}#{1,6}\s+", re.M), ""),  # headings
    (re.compile(r"^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$", re.M), ""),  # horizontal rules
    (re.compile(r"\*\*\*(.+?)\*\*\*", re.S), r"\1"),  # ***bold italic***
    (re.compile(r"\*\*(.+?)\*\*", re.S), r"\1"),  # **bold**
    (re.compile(r"(?<!\w)__(.+?)__(?!\w)", re.S), r"\1"),  # __bold__
    (re.compile(r"^(\s*)[*+-]\s+", re.M), r"\1• "),  # bullet lists -> •
    (re.compile(r"(?<![\w*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![\w*])"), r"\1"),  # *italic*
    (re.compile(r"\*{2,}"), ""),  # leftover unmatched ** markers
    (re.compile(r"[ \t]+$", re.M), ""),  # trailing spaces
    (re.compile(r"\n{3,}"), "\n\n"),  # extra blank lines
]


def clean_markdown(text: str) -> str:
    for pattern, repl in _RULES:
        text = pattern.sub(repl, text)
    return text.strip()
