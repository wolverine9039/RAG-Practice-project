"""Render the evaluation charts for the report from eval/results_*.json into docs/diagrams/.

Requirements (documentation tooling only): pip install matplotlib
Usage: python docs/tools/charts.py
"""
import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "docs" / "diagrams"
local = json.loads((ROOT / "eval" / "results_gemini.json").read_text(encoding="utf-8"))
prod = json.loads((ROOT / "eval" / "results_production.json").read_text(encoding="utf-8"))
base = json.loads((ROOT / "docs" / "archive" / "eval_results_v1_ollama.json").read_text(encoding="utf-8"))

SURFACE, INK, INK2, MUTED, GRID = "#ffffff", "#0b0b0b", "#52514e", "#8a8984", "#e4e3df"
BLUE, ORANGE, GRAY = "#2a78d6", "#eb6834", "#b9b8b3"
plt.rcParams.update({"font.family": "Segoe UI", "font.size": 10, "text.color": INK, "axes.edgecolor": GRID,
                     "axes.labelcolor": INK2, "xtick.color": INK2, "ytick.color": INK2})


def style(ax, grid_axis="x"):
    ax.set_facecolor(SURFACE)
    for s in ("top", "right", "left"):
        ax.spines[s].set_visible(False)
    ax.spines["bottom"].set_color(GRID)
    ax.tick_params(length=0)
    (ax.xaxis if grid_axis == "x" else ax.yaxis).grid(True, color=GRID, linewidth=0.8)
    ax.set_axisbelow(True)


def title(ax, text):
    ax.set_title(text, loc="left", fontsize=11.5, fontweight="bold", color=INK, pad=10)


def save(fig, name):
    fig.savefig(OUT / name, bbox_inches="tight", facecolor=SURFACE)
    plt.close(fig)
    print("wrote", name)


# 1. Retrieval quality by method
ret = local["retrieval"]
names = {"vector_only": "Vector only", "bm25_only": "BM25 only", "hybrid_rrf": "Hybrid (RRF)",
         "bm25_title_filter": "BM25 + title filter", "hybrid_rrf_title_filter (production)": "Hybrid + title filter\n(production)"}
keys = list(names)[::-1]
fig, ax = plt.subplots(figsize=(8.5, 4.6), dpi=200)
fig.patch.set_facecolor(SURFACE)
style(ax)
h = 0.36
ys = range(len(keys))
for vals, off, color, label in ((
        [ret[k]["source_hit@1"] for k in keys], h / 2 + 0.01, BLUE, "Correct rulebook ranked #1 (hit@1)"), (
        [ret[k]["context_recall@6"] for k in keys], -h / 2 - 0.01, ORANGE, "Answer chunk in the top 6 (context recall@6)")):
    bars = ax.barh([y + off for y in ys], vals, height=h, color=color, label=label)
    for b in bars:
        ax.text(b.get_width() + 1, b.get_y() + b.get_height() / 2, f"{b.get_width():.1f}%", va="center", fontsize=9)
ax.set_yticks(list(ys), [names[k] for k in keys], fontsize=9.5, color=INK)
ax.set_xlim(0, 112)
ax.set_xticks([0, 25, 50, 75, 100], ["0%", "25%", "50%", "75%", "100%"])
ax.legend(loc="upper center", bbox_to_anchor=(0.42, -0.08), ncol=2, frameon=False, fontsize=9)
title(ax, "Retrieval quality by method (31 labelled questions, gemini-embedding-2)")
save(fig, "chart_retrieval.png")

# 2. End-to-end accuracy: Ollama baseline vs Gemini (local) vs Gemini (production)
groups = [("rag", "Rulebook\nquestions"), ("follow_ups", "Follow-up\nquestions"), ("off_topic", "Off-topic\nrefusals"),
          ("chitchat", "Small talk")]
b = base["e2e"]
base_vals = [b["rag"]["answer_accuracy"], b["follow_ups"]["answer_accuracy"], b["off_topic"]["correct_refusal_rate"],
             b["chitchat"]["correct_rate"]]
local_vals = [local["e2e"][g]["accuracy"] for g, _ in groups]
prod_vals = [prod[g]["accuracy"] for g, _ in groups]
fig, ax = plt.subplots(figsize=(8.5, 3.9), dpi=200)
fig.patch.set_facecolor(SURFACE)
style(ax, "y")
w = 0.26
xs = range(len(groups))
for vals, off, color, label in ((base_vals, -w, GRAY, "v1: Ollama qwen3.5:9b (local)"),
                                (local_vals, 0, BLUE, "Gemini, local graph"),
                                (prod_vals, w, ORANGE, "Gemini, deployed API (Cloud Run)")):
    bars = ax.bar([x + off for x in xs], vals, width=w, color=color, label=label)
    for bar in bars:
        ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height() + 1.5, f"{bar.get_height():.0f}%", ha="center",
                fontsize=8.5)
ax.set_xticks(list(xs), [l for _, l in groups], fontsize=9.5, color=INK)
ax.set_ylim(0, 115)
ax.set_yticks([0, 25, 50, 75, 100], ["0%", "25%", "50%", "75%", "100%"])
ax.legend(loc="upper center", bbox_to_anchor=(0.5, -0.16), ncol=3, frameon=False, fontsize=9)
title(ax, "End-to-end accuracy by conversation type")
save(fig, "chart_accuracy.png")

# 3. Latency: median and p95 per conversation type, local vs production (+ v1 rulebook baseline)
fig, ax = plt.subplots(figsize=(8.5, 3.9), dpi=200)
fig.patch.set_facecolor(SURFACE)
style(ax)
rows = [("chitchat", "Small talk"), ("off_topic", "Off-topic"), ("follow_ups", "Follow-up"), ("rag", "Rulebook")]
labels, p50s, p95s, colors = [], [], [], []
for g, label in rows:
    for src, name, color in ((local["e2e"], "local", BLUE), (prod, "Cloud Run", ORANGE)):
        labels.append(f"{label} ({name})")
        p50s.append(src[g]["latency"]["p50_s"])
        p95s.append(src[g]["latency"]["p95_s"])
        colors.append(color)
labels.append("Rulebook (v1 Ollama, local)")
p50s.append(b["rag"]["latency"]["p50_s"])
p95s.append(b["rag"]["latency"]["p95_s"])
colors.append(GRAY)
yy = list(range(len(labels)))[::-1]
ax.barh(yy, p95s, height=0.62, color=colors, alpha=0.28)
ax.barh(yy, p50s, height=0.62, color=colors)
for y, p50, p95 in zip(yy, p50s, p95s):
    ax.text(p95 + 0.15, y, f"median {p50:.1f} s, p95 {p95:.1f} s", va="center", fontsize=8.5)
ax.set_yticks(yy, labels, fontsize=9, color=INK)
ax.set_xlim(0, max(p95s) * 1.45)
ax.set_xlabel("seconds per answer (solid: median, light: 95th percentile)", fontsize=9)
title(ax, "Answer latency")
save(fig, "chart_latency.png")
