// Build docs/UNO_RAG_Chatbot_Technical_Report.docx from the evaluation results and the rendered diagrams.
// Usage (from the project root):  node docs/tools/build_report.js
const fs = require("fs");
const path = require("path");
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, ShadingType,
  AlignmentType, ImageRun, TableOfContents, Footer, PageNumber, LevelFormat, BorderStyle, PageBreak, VerticalAlign,
  PageOrientation,
} = require("docx");

const ROOT = path.resolve(__dirname, "..", "..");
const FIG = path.join(ROOT, "docs", "diagrams");
const OUT = path.join(ROOT, "docs", "UNO_RAG_Chatbot_Technical_Report.docx");
const load = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));
const L = load("eval/results_gemini.json");
const PR = load("eval/results_production.json");
const S = load("eval/results_security.json");
const B = load("docs/archive/eval_results_v1_ollama.json");

const W = 9026; // A4 content width in DXA (11906 - 2 * 1440)
const BLUE = "2A78D6", DARK = "1F3A5F", INK2 = "52514E", HEAD_FILL = "E8F1FB", ALT_FILL = "F7F7F5", NOTE_FILL = "FDEEE7";
const FONT = "Calibri", MONO = "Consolas";

// ---------------- helpers ----------------
function runs(text, base = {}) {
  // **bold** and `code` inline markup
  const out = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(new TextRun({ text: text.slice(last, m.index), ...base }));
    const t = m[0];
    if (t.startsWith("**")) out.push(new TextRun({ text: t.slice(2, -2), bold: true, ...base }));
    else out.push(new TextRun({ text: t.slice(1, -1), font: MONO, size: 18, color: "7A3E00", ...base }));
    last = m.index + t.length;
  }
  if (last < text.length) out.push(new TextRun({ text: text.slice(last), ...base }));
  return out;
}
const P = (text, opts = {}) => new Paragraph({ children: runs(text, opts.run || {}), spacing: { after: 120, line: 276 }, ...opts.para });
const H1 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(t)], pageBreakBefore: true });
const H2 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(t)] });
const H3 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_3, children: [new TextRun(t)] });
const bullet = (t, level = 0) => new Paragraph({ numbering: { reference: "bullets", level }, children: runs(t), spacing: { after: 60, line: 264 } });
const bullets = (items) => items.map((t) => (Array.isArray(t) ? bullet(t[0], 1) : bullet(t)));
let listInstance = 0;
function steps(items) {
  listInstance += 1;
  return items.map((t) => new Paragraph({ numbering: { reference: "steps", level: 0, instance: listInstance }, children: runs(t), spacing: { after: 60, line: 264 } }));
}
function code(lines) {
  return lines.map((l, i) => new Paragraph({
    children: [new TextRun({ text: l || " ", font: MONO, size: 17 })],
    shading: { type: ShadingType.CLEAR, color: "auto", fill: "F2F2EF" },
    spacing: { before: i === 0 ? 80 : 0, after: i === lines.length - 1 ? 160 : 0 },
    indent: { left: 120, right: 120 },
  }));
}
function note(text) {
  return new Paragraph({
    children: runs(text), shading: { type: ShadingType.CLEAR, color: "auto", fill: NOTE_FILL },
    border: { left: { style: BorderStyle.SINGLE, size: 18, color: "EB6834", space: 6 } },
    spacing: { before: 80, after: 160, line: 264 }, indent: { left: 160, right: 160 },
  });
}
const border = { style: BorderStyle.SINGLE, size: 4, color: "C9C8C3" };
const borders = { top: border, bottom: border, left: border, right: border };
function table(headers, rows, widths, opts = {}) {
  const sum = widths.reduce((a, b) => a + b, 0);
  if (sum !== W) widths = widths.map((w) => Math.round((w * W) / sum));
  widths[widths.length - 1] += W - widths.reduce((a, b) => a + b, 0);
  const cell = (text, w, isHead, fill, align) => new TableCell({
    width: { size: w, type: WidthType.DXA }, borders, verticalAlign: VerticalAlign.CENTER,
    shading: fill ? { type: ShadingType.CLEAR, color: "auto", fill } : undefined,
    margins: { top: 50, bottom: 50, left: 90, right: 90 },
    children: String(text).split("\n").map((line) => new Paragraph({
      alignment: align || AlignmentType.LEFT, children: runs(line, { size: opts.size || 18, bold: isHead || undefined }),
    })),
  });
  const head = new TableRow({ tableHeader: true, cantSplit: true, children: headers.map((h, i) => cell(h, widths[i], true, HEAD_FILL)) });
  const body = rows.map((r, ri) => new TableRow({
    cantSplit: true,
    children: r.map((c, i) => cell(c, widths[i], false, ri % 2 ? ALT_FILL : undefined,
      opts.right && opts.right.includes(i) ? AlignmentType.RIGHT : undefined)),
  }));
  return [new Table({ width: { size: W, type: WidthType.DXA }, columnWidths: widths, rows: [head, ...body] }),
    new Paragraph({ children: [], spacing: { after: 100 } })];
}
function pngSize(file) {
  const b = fs.readFileSync(file);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}
// Figures in document order; prose cites them with fig("file.png") so numbers always match
const ORDER = [
  "01_architecture.png", "15_data_flow.png", "03_ingestion_pipeline.png", "17_data_stores.png", "16_chroma_schema.png", "04_retrieval_pipeline.png", "chart_retrieval.png",
  "05_langgraph_flow.png", "06a_chat_sequence_frontend.png", "06b_chat_sequence_backend.png", "07_feedback_sequence.png",
  "11_frontend_components.png", "09_security_layers.png", "08_api_key_flow.png", "10_rate_limiting_flow.png",
  "02_deployment_topology.png", "12_deploy_backend.png", "13_deploy_wordpress.png", "chart_accuracy.png", "chart_latency.png",
  "14_setup_from_scratch.png",
];
const fig = (file) => {
  const i = ORDER.indexOf(file);
  if (i < 0) throw new Error(`figure not in ORDER: ${file}`);
  return i + 1;
};
let figNo = 0;
function figure(file, caption, { maxW = 600, maxH = 800, scale = 0.62, land = false } = {}) {
  // PNGs are rendered at 2x; draw them at `scale` of their CSS size, capped by the page box
  if (land) { maxW = 900; maxH = Math.min(maxH, 520); scale = 0.75; }
  const f = path.join(FIG, file);
  const { w, h } = pngSize(f);
  let dw = Math.min(maxW, Math.round((w / 2) * scale));
  let dh = Math.round((dw * h) / w);
  if (dh > maxH) { dh = maxH; dw = Math.round((dh * w) / h); }
  figNo += 1;
  if (ORDER[figNo - 1] !== file) throw new Error(`figure order: expected ${ORDER[figNo - 1]}, got ${file}`);
  const label = `Figure ${figNo}. ${caption}`;
  return [
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 120, after: 60 }, keepNext: true,
      children: [new ImageRun({ type: "png", data: fs.readFileSync(f), transformation: { width: dw, height: dh },
        altText: { title: caption, description: caption, name: file } })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 200 }, children: [new TextRun({ text: label, italics: true, size: 18, color: INK2 })] }),
  ];
}
const pct = (x) => (x === null || x === undefined ? "–" : `${Number(x).toFixed(Number(x) % 1 ? 1 : 0)}%`);
const sec = (x) => `${Number(x).toFixed(1)} s`;

// ---------------- data ----------------
const RET = L.retrieval;
const PROD_RET = RET["hybrid_rrf_title_filter (production)"];
const E = L.e2e;
const BE = B.e2e;
const nOk = (g) => Math.round((g.accuracy / 100) * g.n);
const secSummary = S.summary;
const prodCached = PR.details.filter((d) => d.cached).length;
const children = [];
const add = (...xs) => xs.flat().forEach((x) => children.push(x));
// Content placed on its own landscape page (wide diagrams)
const landscape = (...items) => ({ landscape: items.flat() });

// ---------------- title page ----------------
add(
  new Paragraph({ spacing: { before: 2200, after: 120 }, children: [new TextRun({ text: "UNO Rulebook RAG Chatbot", bold: true, size: 56, color: DARK })] }),
  new Paragraph({ spacing: { after: 360 }, children: [new TextRun({ text: "Technical report: architecture, data flow, APIs, front end, security, deployment, setup and evaluation", size: 28, color: INK2 })] }),
  new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: BLUE, space: 1 } }, spacing: { after: 360 }, children: [] }),
  table(["Item", "Details"], [
    ["Live site", "https://uno-chatbot.buildwithmayank.tech (chat page: /uno-rules-chat/)"],
    ["Backend", "Google Cloud Run service `uno-rag-backend` (us-central1)"],
    ["Stack", "Python 3.13 · FastAPI · LangGraph · ChromaDB + BM25 · pdfplumber · Gemini on Vertex AI · WordPress plugin · Caddy · Cloudflare · Langfuse"],
    ["Version", "2.0 (supersedes the first, Ollama-based report of 29 October 2026, kept in docs/archive/)"],
    ["Prepared by", "Mayank Bisht"],
    ["Date", "1 November 2026"],
    ["Evaluation", `Local run ${L.e2e_run_at}, production run ${PR.run_at}, security checks ${S.run_at}`],
  ], [1900, 7126]),
  new Paragraph({ children: [new PageBreak()] }),
  new Paragraph({ spacing: { after: 200 }, children: [new TextRun({ text: "Contents", bold: true, size: 32, color: DARK })] }),
  new TableOfContents("Contents", { hyperlink: true, headingStyleRange: "1-2" }),
);

// ---------------- 1. Executive summary ----------------
add(
  H1("1. Executive summary"),
  P("The UNO Rulebook RAG Chatbot answers natural-language questions about five UNO rulebooks: Classic UNO, UNO Flip, UNO Dare, UNO No Mercy and UNO All Wild. It answers only from the rulebook PDFs and shows the rulebook and page behind each answer. Questions outside the rulebooks are politely refused, and small talk is answered without searching."),
  P("Visitors use a WordPress site. A custom WordPress plugin provides the chat widget and forwards each question server-side to a Python backend (FastAPI + LangGraph) on Google Cloud Run. The backend runs a retrieval-augmented generation (RAG) flow:"),
  ...steps([
    "**Route:** a small Gemini model classifies the message and rewrites follow-ups into a standalone question.",
    "**Retrieve:** a hybrid keyword and vector search picks the 6 most relevant rulebook passages.",
    "**Answer:** a larger Gemini model answers from those passages only.",
  ]),
  P("Every turn is traced in Langfuse, and visitors can rate answers with thumbs up/down."),
  P("Headline results, all measured on the actual system (section 13):"),
  table(["Measure", "Result", "Notes"], [
    ["Rulebook answers correct (local / deployed)", `**${nOk(E.rag)}/${E.rag.n}** / **${nOk(PR.rag)}/${PR.rag.n}**`, "Answer contains every required fact"],
    ["Correct rulebook cited", `${pct(E.rag.citation_accuracy)} / ${pct(PR.rag.citation_accuracy)}`, "Source chips name the right PDF"],
    ["Off-topic refused, small talk, follow-ups", `${nOk(E.off_topic)}/${E.off_topic.n}, ${nOk(E.chitchat)}/${E.chitchat.n}, ${nOk(E.follow_ups)}/${E.follow_ups.n}`, "Same results on the deployed API"],
    ["Correct rulebook ranked first by retrieval", pct(PROD_RET["source_hit@1"]), `Answer passage in the top 6: ${pct(PROD_RET["context_recall@6"])}`],
    ["Median answer time, rulebook question", `${sec(E.rag.latency.p50_s)} local, ${sec(PR.rag.latency.p50_s)} deployed`, `First version (local Ollama model): ${sec(BE.rag.latency.p50_s)}`],
    ["Automated security checks", `**${secSummary.PASS} passed**, ${secSummary.FAIL} failed`, `${secSummary.INFO} informational findings (section 10.9)`],
    ["Running cost", "about $18/month + Gemini usage", "VM, static IP and disk; Cloud Run stays in its free tier"],
  ], [3300, 2500, 3226]),
  P("The system has six layers of protection:"),
  ...bullets([
    "**Cloudflare** in front of the site.",
    "**A firewall** that admits only Cloudflare.",
    "**Per-IP rate limits** in Caddy.",
    "**WordPress nonce checks and question limits.**",
    "**A secret API key** between WordPress and the backend.",
    "**A least-privilege Google service account** for the Gemini calls.",
  ]),
  P("API keys never reach the browser."),
);

// ---------------- 2. Architecture ----------------
add(
  H1("2. System architecture"),
  P(`The system has four runtime parts. The **front end** is WordPress on a Compute Engine VM, behind Cloudflare and Caddy. The **backend** is FastAPI + LangGraph on Cloud Run. The **models** are Gemini on Vertex AI. **Monitoring** is Langfuse Cloud. Figure ${fig("01_architecture.png")} shows how they connect.`),
  figure("01_architecture.png", "System architecture", { scale: 0.5, maxH: 700 }),
  table(["Component", "Technology", "Runs on", "Responsibility"], [
    ["Edge", "Cloudflare (free plan)", "Cloudflare network", "DNS, TLS to visitors, DDoS protection, caching of static files, real visitor IP header"],
    ["Web server", "Caddy 2 + caddy-ratelimit", "VM (Docker)", "HTTPS certificate (Let's Encrypt), per-IP rate limits, reverse proxy to WordPress"],
    ["Website", "WordPress 6 (PHP 8.3), theme Twenty Twenty-Five", "VM (Docker)", "Home page, chat page, admin; hosts the plugin"],
    ["Chat plugin", "Custom plugin uno-rag-chatbot 1.6.0", "Inside WordPress", "Chat widget (JS), REST proxy to the backend, nonce check, question limits, settings page"],
    ["Database", "MariaDB 11", "VM (Docker)", "WordPress content, plugin settings, rate-limit counters"],
    ["API", "FastAPI + Uvicorn", "Cloud Run", "/chat, /feedback, /health; API-key check, validation, answer cache, tracing"],
    ["RAG flow", "LangGraph", "Cloud Run", "Routing, retrieval, grounded answering, query rewrite, conversation memory"],
    ["Search index", "ChromaDB (cosine HNSW) + rank_bm25", "Cloud Run (baked into the image)", "60 rulebook chunks with 768-d embeddings; keyword index built in memory"],
    ["Models", "gemini-3.5-flash-lite, gemini-3.5-flash, gemini-embedding-2", "Vertex AI (global)", "Router/rewrite, answers, embeddings"],
    ["Monitoring", "Langfuse Cloud (Hobby)", "SaaS (EU)", "Traces, user-feedback scores, evaluation datasets and experiments"],
  ], [1300, 2300, 1600, 3826], { size: 17 }),
  H2("2.1 How data flows"),
  P(`Data moves in two phases (Figure ${fig("15_data_flow.png")}):`),
  ...bullets([
    "**Indexing** runs offline when the rulebooks change. It turns the PDFs into embedded chunks in Chroma.",
    "**Answering** runs for every question. It reads the index and produces an answer with its sources.",
  ]),
  P("Each answer also feeds the answer cache, so a repeated first question costs no model calls. It also produces a Langfuse trace, which later receives the visitor's thumbs up/down."),
  figure("15_data_flow.png", "Data flow: indexing and answering", { scale: 0.58 }),
  P("Where data is stored (schemas in sections 4.4–4.9):"),
  table(["Data", "Stored in", "Lifetime"], [
    ["Rulebook PDFs", "Data/ in the repository and in the backend image", "Permanent"],
    ["Chunks + embeddings", "chroma_db/ locally; copied into the Cloud Run image", "Until the next ingest"],
    ["Conversation memory", "LangGraph MemorySaver (RAM of the Cloud Run instance), keyed by session_id", "Until the instance stops (about 15 minutes idle) or New chat"],
    ["Answer cache, query-embedding cache, usage counter", "SQLite/JSON in CACHE_DIR (/tmp on Cloud Run)", "Per instance on Cloud Run; persistent locally"],
    ["Session id", "Browser localStorage key uno_chat_session", "Until New chat or cleared storage"],
    ["Plugin settings, rate-limit counters, daily question count", "WordPress options/transients in MariaDB", "Settings permanent; counters 1 hour / 1 day"],
    ["Traces and feedback", "Langfuse Cloud", "Per Langfuse plan retention"],
  ], [2600, 4000, 2426]),
);

// ---------------- 3. Project structure ----------------
const fileRows = (rows) => rows.map(([f, r]) => [`\`${f}\``, r]);
add(
  H1("3. Project structure"),
  P("The repository holds the backend, the WordPress plugin, both deployments, the evaluation suite and this documentation. Cloud Run builds the backend image from the repository root, so the files that control that build sit at the root."),
  ...code([
    "RAG Practice project/",
    "├── app/                      FastAPI + LangGraph backend (Python package)",
    "├── Data/                     the five rulebook PDFs",
    "├── eval/                     evaluation: dataset, runners, results",
    "├── wordpress/",
    "│   ├── uno-rag-chatbot/      WordPress plugin (PHP + JS + CSS)",
    "│   ├── setup/pages.php       creates Home page, chat page, menu",
    "│   ├── setup.ps1             local WordPress in Docker",
    "│   └── build_zip.py          packages the plugin",
    "├── deploy/",
    "│   ├── cloudrun/             backend deployment scripts",
    "│   └── wordpress/            VM deployment (Docker, Caddy, scripts)",
    "├── docs/                     this report, diagrams, report tooling, archive",
    "├── Dockerfile                backend image",
    "├── .dockerignore / .gcloudignore   what goes into the image / upload",
    "├── docker-compose.yml        local WordPress stack",
    "├── requirements.txt          Python dependencies",
    "├── .env.example              configuration template (.env is git-ignored)",
    "└── README.md                 quick-start guide",
  ]),
  H2("3.1 Role of each file"),
  H3("Backend: app/"),
  ...table(["File", "Role"], fileRows([
    ["app/main.py", "FastAPI app. Routes `/`, `/health`, `/chat`, `/feedback`, `DELETE /chat/{id}`, `/ingest`. Request/response schemas, `X-API-Key` check, answer cache, one Langfuse trace per turn, startup (graph, cache, auto-ingest) and per-request trace flush on Cloud Run."],
    ["app/graph.py", "LangGraph state machine: `analyze` → `respond_direct` or `retrieve` → `answer` → optional `rewrite_query`. Holds the state schema, routing functions, follow-up guard and the MemorySaver checkpointer."],
    ["app/prompts.py", "Prompt templates: ANALYZE (route + standalone question + small-talk reply, JSON), ANSWER (grounded JSON answer, quote numbers verbatim), REWRITE; fixed refusal texts."],
    ["app/llm.py", "Gemini integration: Vertex AI client, chat models per role (router/answer), retries on 429/5xx, auth error help, daily request budget (UsageTracker), SQLite key-value caches, gemini-embedding-2 embeddings with prefixes and parallel requests, JSON parsing, health status."],
    ["app/vectorstore.py", "Chroma vector store, in-memory BM25 index, rulebook alias detection (`detect_sources`), hybrid search with reciprocal rank fusion."],
    ["app/ingest.py", "Indexing: pdfplumber extraction (text + tables), cleaning, duplicate-page removal, chunking, contextual header, ids, writing to Chroma. CLI: `python -m app.ingest --reset`."],
    ["app/observability.py", "Langfuse client, LangChain callback handler, `trace_turn` (one root trace per chat turn with tags), embedding traces, scores, auth check, flush."],
    ["app/formatting.py", "Removes Markdown from model output so the widget shows clean plain text."],
    ["app/model_status.py", "CLI that lists the Gemini models available to the project and checks the configured ones (metadata only, no cost)."],
    ["app/config.py", "All settings (pydantic-settings) loaded from `.env`, with path helpers."],
  ]), [2300, 6726]),
  H3("Evaluation: eval/"),
  ...table(["File", "Role"], fileRows([
    ["eval/dataset.py", "Hand-labelled test set: 31 rulebook questions (required facts, source PDF, evidence text), 6 off-topic, 16 small-talk, 4 two-turn follow-ups."],
    ["eval/run_eval.py", "Retrieval metrics for 5 search methods and end-to-end accuracy/latency on the local graph (Langfuse experiment); `--backend-url` runs the same questions against the deployed API."],
    ["eval/security_checks.py", "Automated checks of the live security measures (auth, firewall, Cloudflare, nonce, rate limits, secret exposure)."],
    ["eval/results_gemini.json", "Latest local results (retrieval + end-to-end)."],
    ["eval/results_production.json", "Latest results against Cloud Run."],
    ["eval/results_security.json", "Latest security-check results."],
  ]), [2300, 6726]),
  H3("WordPress plugin: wordpress/uno-rag-chatbot/"),
  ...table(["File", "Role"], fileRows([
    ["uno-rag-chatbot.php", "Plugin main file: settings page (Settings → UNO Chatbot), `[uno_chatbot]` shortcode, floating bubble, script/style loading with REST URL + nonce, REST routes `uno-chat/v1/ask|feedback|reset`, nonce check, per-IP and site-wide limits, server-side calls to the backend with `X-API-Key`."],
    ["includes/home.php", "`[uno_chatbot_home]` landing page: hero, rulebooks covered, how it works, features, link to the chat page."],
    ["assets/chatbot.js", "Chat widget: session id in localStorage, welcome text, suggestion buttons, sending questions, typing indicator, answer bubbles (textContent only), source chips, thumbs up/down, New chat."],
    ["assets/chatbot.css", "Widget styles: dark ember theme, inline/page/floating layouts."],
    ["assets/home.css", "Landing page styles."],
    ["uninstall.php", "Deletes the plugin settings and daily counters when the plugin is deleted."],
    ["readme.txt", "WordPress plugin readme and changelog."],
  ]), [2300, 6726]),
  H3("WordPress setup and packaging: wordpress/"),
  ...table(["File", "Role"], fileRows([
    ["wordpress/setup/pages.php", "Creates/updates the chat page, the Home page (front page) and the Home-only navigation menu. Used by both the local and the cloud setup (`wp eval-file`)."],
    ["wordpress/setup.ps1", "Local setup: starts Docker WordPress, installs it, activates the plugin, saves settings, runs pages.php."],
    ["wordpress/build_zip.py", "Packages the plugin to dist/uno-rag-chatbot.zip for upload to any WordPress site."],
    ["docker-compose.yml (root)", "Local development stack: WordPress, MariaDB and a wp-cli tool container; the plugin folder is mounted live."],
  ]), [2300, 6726]),
  H3("Deployment: deploy/"),
  ...table(["File", "Role"], fileRows([
    ["deploy/cloudrun/deploy.ps1", "Backend deployment: enables APIs, service account + Vertex AI User role (skippable), prepares index and env file, `gcloud run deploy --source .`, deletes the env file."],
    ["deploy/cloudrun/prepare_index.py", "Copies only the active Chroma collection (with its embeddings) into deploy/build/chroma_db for the image."],
    ["deploy/cloudrun/make_env.py", "Turns `.env` into the Cloud Run env-vars file with Cloud Run overrides (cache in /tmp, production tracing)."],
    ["deploy/wordpress/deploy.ps1", "VM deployment: static IP, firewall, VM, Cloudflare checks, bundle upload, runs vm-setup.sh, firewall lock to Cloudflare, fetches admin credentials."],
    ["deploy/wordpress/vm-setup.sh", "Runs on the VM: Docker, swap, DB passwords, `docker compose up --build`, WordPress install, plugin settings, pages."],
    ["deploy/wordpress/docker-compose.yml", "Production stack: MariaDB (memory-tuned), WordPress (no public port), Caddy (80/443), wp-cli; log caps; real-IP config."],
    ["deploy/wordpress/Caddyfile", "HTTPS site, trusted Cloudflare ranges, per-IP rate-limit zones, xmlrpc block, reverse proxy with X-Real-IP."],
    ["deploy/wordpress/caddy/Dockerfile", "Builds Caddy with the caddy-ratelimit module."],
    ["deploy/wordpress/plugin-options.php", "Saves the backend URL and key (read from stdin) into the plugin settings, keeping admin changes."],
  ]), [2300, 6726]),
  H3("Root files and documentation"),
  ...table(["File", "Role"], fileRows([
    ["Dockerfile", "Backend image: python:3.13-slim, dependencies, app + PDFs + pre-built index, non-root user, Uvicorn on $PORT."],
    [".gcloudignore / .dockerignore", "Keep secrets and unrelated folders (.env, .venv, WordPress, docs, eval) out of the Cloud Run upload and image."],
    ["requirements.txt", "Python dependencies (section 8.4)."],
    [".env.example", "Template of every setting with comments; copy to `.env`."],
    [".gitignore", "Excludes secrets, virtualenv, generated index/caches, build output, credentials."],
    ["README.md", "Quick start, deployment commands, API and configuration reference."],
    ["docs/", "This report (.docx/.pdf), diagrams (Mermaid sources + PNG), tools to regenerate them, archive of the first report."],
  ]), [2300, 6726]),
  H2("3.2 Generated and local-only folders"),
  table(["Folder / file", "Created by", "In git?"], [
    [".venv/", "python -m venv", "No"],
    [".env", "copied from .env.example", "No (secrets)"],
    ["chroma_db/", "python -m app.ingest", "No (rebuildable)"],
    ["cache/", "backend at runtime (answer + embedding caches, usage counter)", "No"],
    ["deploy/build/", "prepare_index.py during a Cloud Run deploy", "No"],
    ["dist/", "wordpress/build_zip.py", "No"],
    ["wordpress/admin-credentials*.txt", "setup.ps1 / deploy.ps1", "No (passwords)"],
    ["docs/tools/node_modules/", "npm install (report tooling)", "No"],
  ], [3000, 4300, 1726]),
);

// ---------------- 4. Ingestion ----------------
add(
  H1("4. Data ingestion and databases"),
  P(`\`python -m app.ingest --reset\` turns the PDFs in \`Data/\` into searchable chunks (Figure ${fig("03_ingestion_pipeline.png")}). Ingestion runs locally. The finished index is copied into the Cloud Run image, so the deployed backend never re-embeds the PDFs on start-up.`),
  figure("03_ingestion_pipeline.png", "Ingestion pipeline", { scale: 0.6, maxH: 720 }),
  H2("4.1 Steps"),
  ...steps([
    "**Extract:** pdfplumber reads each page's text and tables. Tables become text rows joined with `|`.",
    "**Clean:** extraction noise is removed (details below the list).",
    "**Drop duplicates:** a page whose cleaned text hashes to one already seen is skipped (some PDFs repeat pages).",
    "**Chunk:** `RecursiveCharacterTextSplitter` with 1000 characters and 150 overlap. Chunks average about 860 characters.",
    "**Add context:** every chunk starts with `Rulebook: <Title>`, so both the embedding and the answer model know which edition it belongs to. Each chunk gets the id `file:page:chunk` and the metadata `source`, `page`, `chunk` and `title`.",
    "**Embed:** gemini-embedding-2 at 768 dimensions. This model takes one text per request and ignores the task type, so the task is given as a text prefix (`title: none | text: ` for documents) and 8 requests run in parallel.",
    "**Store:** Chroma collection `uno_docs_gemini` (cosine distance, HNSW index). The BM25 keyword index is built in memory from the same chunks when the backend starts.",
  ]),
  P("The cleaning in step 2 does three things:"),
  ...bullets([
    "Collapses doubled glyphs (`dedupe_chars`).",
    "Removes `(cid:N)` font codes.",
    "Drops lines that are mostly unreadable symbols.",
  ]),
  H2("4.2 Corpus"),
  table(["Rulebook (file)", "Pages kept", "Chunks", "Alias used for filtering"], [
    ["UNO Flip (uno flip.pdf)", "1", "29", "flip"],
    ["UNO No Mercy (Uno No mercy.pdf)", "1", "11", "no mercy"],
    ["UNO Dare (Uno Dare.pdf)", "1", "10", "dare"],
    ["UNO All Wild (uno-all-wild-rules-…pdf)", "3", "7", "all wild"],
    ["Classic UNO (uno classic.pdf)", "1", "3", "classic"],
    ["**Total**", "**7**", "**60**", ""],
  ], [3800, 1400, 1200, 2626], { right: [1, 2] }),
  H2("4.3 Vector database schema"),
  P("Chroma stores everything in `chroma_db/chroma.sqlite3` plus one HNSW index folder for the collection:"),
  table(["Field", "Type", "Example", "Purpose"], [
    ["id", "string", "uno flip.pdf:1:4", "Stable chunk id (file:page:chunk); re-ingest overwrites"],
    ["document", "text", "Rulebook: Uno Flip\\nSKIP EVERYONE: …", "Chunk text with contextual header"],
    ["embedding", "float[768]", "[0.012, -0.044, …]", "gemini-embedding-2 vector (cosine)"],
    ["metadata.source", "string", "uno flip.pdf", "Source file; shown to users as the citation"],
    ["metadata.page", "int", "1", "Page number in the PDF (shown as p.1)"],
    ["metadata.chunk", "int", "4", "Position of the chunk within its page"],
    ["metadata.title", "string", "Uno Flip", "Rulebook title; basis for the alias used by the title filter"],
    ["collection metadata", "map", "hnsw:space = cosine", "Distance function of the HNSW index"],
  ], [1800, 1100, 2700, 3426], { size: 17 }),
);

// ---------------- 4.4+ databases ----------------
add(
  landscape(H2("4.4 Data stores overview"),
    P(`The system keeps data in six places. Figure ${fig("17_data_stores.png")} shows each store, where it lives and how data moves between them.`),
    figure("17_data_stores.png", "All data stores and how data moves between them", { land: true })),
  table(["Store", "Technology", "Location", "Contents", "Lifetime / backup"], [
    ["Vector database", "ChromaDB 1.x (SQLite + HNSW)", "chroma_db/ on the PC; /app/chroma_db in the Cloud Run image", "60 chunks, embeddings, metadata", "Rebuilt by ingest; read-only copy baked into each image"],
    ["Answer cache", "SQLite table kv", "cache/answers.sqlite3 (PC); /tmp/uno-cache (Cloud Run)", "First-turn rulebook answers + sources", "Per Cloud Run instance; persistent on the PC"],
    ["Query-embedding cache", "SQLite table kv", "cache/query_embeddings.sqlite3", "768-d query vectors", "Same as above"],
    ["Usage counter", "JSON file", "cache/usage.json", "Model requests today", "Resets each UTC day (and per instance)"],
    ["Conversation memory", "LangGraph MemorySaver", "RAM of the backend process", "Graph state per session_id", "Until restart / scale to zero / New chat"],
    ["Website database", "MariaDB 11", "Docker volume db_data on the VM", "WordPress content, plugin settings, limits", "Persistent; back up with VM disk snapshots"],
    ["Browser storage", "localStorage", "Visitor's browser", "Session id", "Until New chat or cleared"],
    ["Monitoring store", "Langfuse Cloud", "SaaS (EU)", "Traces, scores, datasets", "Langfuse plan retention"],
  ], [1500, 1500, 2300, 1900, 1826], { size: 16 }),
);
add(
  H2("4.5 Vector database (ChromaDB) schema"),
  P("Chroma runs embedded in the backend process (`chromadb.PersistentClient`); there is no separate database server. One folder holds everything:"),
  ...code([
    "chroma_db/",
    "├── chroma.sqlite3            catalogue, chunk ids, metadata, text,",
    "│                             full-text index, write-ahead queue",
    "└── <segment UUID>/          HNSW vector index (uno_docs_gemini)",
    "    ├── data_level0.bin       768-d vectors + base graph layer",
    "    ├── link_lists.bin        upper graph layers",
    "    ├── header.bin            index parameters (cosine, M, ef)",
    "    └── length.bin            label to embedding map",
  ]),
  P(`Inside \`chroma.sqlite3\`, the tables relate as in Figure ${fig("16_chroma_schema.png")}. Each collection has two segments: a **METADATA** segment (rows in SQLite) and a **VECTOR** segment (the HNSW files). Chroma keeps the two in sync through the \`embeddings_queue\` write-ahead log.`),
  figure("16_chroma_schema.png", "ChromaDB storage schema (chroma.sqlite3 + HNSW files)", { maxW: 600, maxH: 860 }),
  table(["Table", "Rows (current)", "Purpose"], [
    ["tenants / databases", "1 / 1", "Namespaces (default_tenant / default_database)"],
    ["collections", "1", "uno_docs_gemini, dimension 768, HNSW configuration (JSON)"],
    ["collection_metadata", "1", "hnsw:space = cosine"],
    ["segments", "2", "One VECTOR segment (HNSW files, folder named by its UUID) and one METADATA segment (SQLite)"],
    ["embeddings", "60", "One row per chunk: internal id, segment, embedding_id (= chunk id file:page:chunk), sequence number, created_at"],
    ["embedding_metadata", "300", "Key/value rows per chunk: source, page, chunk, title and chroma:document (the chunk text): 5 keys × 60 chunks"],
    ["embedding_fulltext_search (+ _content, _data, _docsize, _idx, _config)", "60", "SQLite FTS5 trigram index of the chunk text (used by Chroma's where_document filters)"],
    ["embeddings_queue (+ _config)", "60", "Write-ahead log of add/update/delete operations with the vector and metadata, applied to both segments"],
    ["max_seq_id", "1", "Last applied queue position per segment"],
    ["segment_metadata, embedding_metadata_array, maintenance_log", "0", "Unused here"],
    ["migrations, acquire_write", "18 / 11", "Chroma's own schema migrations and write locks"],
  ], [3000, 1300, 4726], { size: 16 }),
  P("Logical record of one chunk, as the application reads and writes it through the Chroma API:"),
  ...code([
    "id        \"uno flip.pdf:1:4\"             (file:page:chunk)",
    "document  \"Rulebook: Uno Flip\\nSKIP ...\"   (header + text, ~860 chars)",
    "embedding [768 floats]                 (gemini-embedding-2)",
    "metadata  {source: \"uno flip.pdf\", page: 1, chunk: 4, title: \"Uno Flip\"}",
  ]),
  P("How the backend uses it:"),
  ...bullets([
    "**Similarity search:** `asimilarity_search(query, k=18, filter={\"source\": {\"$in\": [...]}})`, which finds the nearest vectors (cosine) and returns them with document and metadata.",
    "**Keyword index:** `get(include=[documents, metadatas])` loads all 60 chunks once to build the in-memory BM25 index and the rulebook aliases.",
    "**Writes:** only `python -m app.ingest` (delete and re-create the collection with `--reset`, then `add_documents` with ids), or `POST /ingest`.",
    "**Deploy copy:** `deploy/cloudrun/prepare_index.py` copies only this collection, with its stored embeddings, into a clean folder for the image. No embedding requests are made.",
  ]),
);
add(
  H2("4.6 Backend caches and usage counter"),
  P("Both caches are small SQLite databases with one table, written by `KVCache` in `app/llm.py`:"),
  ...code([
    "CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);",
  ]),
  table(["File", "Key k", "Value v (JSON)", "Written when"], [
    ["answers.sqlite3", "SHA-256 of router model, answer model, embed model, collection, prompt fingerprint and the normalized question (lower case, spaces collapsed, trailing ?!. removed)", "{\"answer\": \"...\", \"sources\": [{\"source\": \"Uno No mercy.pdf\", \"page\": 1}]}", "A first-turn rulebook question was answered from the rulebooks (found = true)"],
    ["query_embeddings.sqlite3", "SHA-256 of embed model, dimensions and prefix + query text", "[768 floats]", "A search query was embedded"],
  ], [1800, 3100, 2300, 1826], { size: 16 }),
  P("Because the models, collection and prompts are part of the key, changing any of them automatically invalidates old entries. Nothing personal is stored: only questions, answers and vectors."),
  P("The daily usage counter is a small JSON file, `usage.json`:"),
  ...code(["{\"date\": \"2026-11-01\", \"count\": 512}   # requests on this UTC date"]),
  P("Every Gemini request first calls `usage.reserve()`. When `count` would pass `DAILY_REQUEST_BUDGET` (2000), the call raises `DailyLimitReached` and the API answers 429."),
);
add(
  H2("4.7 Conversation memory (LangGraph state)"),
  P("LangGraph's `MemorySaver` keeps one checkpoint per thread (`thread_id` = the widget's `session_id`) in the backend's memory. Each checkpoint stores the graph state:"),
  table(["Field", "Type", "Meaning"], [
    ["messages", "list[BaseMessage] (append-only)", "The conversation: HumanMessage / AIMessage pairs; the last 6 are given to the router"],
    ["question", "str", "The visitor's latest message"],
    ["route", "str", "chitchat, rulebook or off_topic"],
    ["reply", "str", "Small-talk reply drafted by the router"],
    ["standalone_question", "str", "The question rewritten without chat context"],
    ["search_query", "str", "Text sent to retrieval (changes after a rewrite)"],
    ["documents", "list[Document]", "The 6 retrieved chunks"],
    ["used_documents", "list[Document]", "Chunks the answer used, which become the sources"],
    ["found", "bool", "Whether the answer model found the answer in the chunks"],
    ["rewrites", "int", "How many query rewrites were done (max 1)"],
  ], [2200, 2400, 4426], { size: 16 }),
  P("`DELETE /chat/{session_id}` (the New chat button) deletes the thread. Memory is lost when the Cloud Run instance stops. That's acceptable for short rule questions; a persistent checkpointer (for example Postgres) would keep conversations across restarts."),
);
add(
  H2("4.8 WordPress database (MariaDB)"),
  P("WordPress uses its standard schema in the database `wordpress` with the table prefix `wp_`:"),
  ...bullets([
    "`wp_posts`, `wp_postmeta`",
    "`wp_options`",
    "`wp_users`, `wp_usermeta`",
    "`wp_terms`, `wp_term_taxonomy`, `wp_term_relationships`, `wp_termmeta`",
    "`wp_comments`, `wp_commentmeta`",
    "`wp_links`",
  ]),
  P("The plugin creates **no tables of its own**. It stores its data in `wp_options`, with this layout:"),
  ...code([
    "CREATE TABLE wp_options (",
    "  option_id    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,",
    "  option_name  VARCHAR(191) NOT NULL UNIQUE,",
    "  option_value LONGTEXT NOT NULL,          -- PHP-serialized for arrays",
    "  autoload     VARCHAR(20) NOT NULL DEFAULT 'yes'",
    ");",
  ]),
  table(["option_name", "option_value", "Written by"], [
    ["uno_rag_chatbot_options", "Serialized array: backend_url, api_key, title, welcome, floating (0/1), per_hour (questions per visitor per hour), per_day (site-wide daily cap)", "Settings page; deploy (plugin-options.php)"],
    ["uno_chat_day_YYYYMMDD", "Integer: questions answered site-wide on that UTC day (autoload off; incremented in SQL with UPDATE … + 1; older days deleted)", "/ask"],
    ["_transient_uno_chat_rl_<md5(IP)>", "Serialized array {count, reset (unix time)}: questions by one IP in the current hour", "/ask"],
    ["_transient_uno_chat_fb_<md5(IP)>", "Same format for thumbs up/down ratings (limit 60/hour)", "/feedback"],
    ["_transient_timeout_uno_chat_*", "Expiry time of the matching transient", "WordPress"],
  ], [2500, 4500, 2026], { size: 16 }),
  P("Content created by `wordpress/setup/pages.php`:"),
  table(["Table", "Rows", "Values"], [
    ["wp_posts", "Page home", "post_type page, content `[uno_chatbot_home]` shortcode block"],
    ["wp_posts", "Page uno-rules-chat", "post_type page, content `[uno_chatbot layout=\"page\"]` shortcode block"],
    ["wp_posts", "Main menu", "post_type wp_navigation with a single Home link"],
    ["wp_postmeta", "_wp_page_template", "page-no-title for both pages"],
    ["wp_options", "show_on_front / page_on_front", "page / ID of the Home page"],
    ["wp_options", "permalink_structure", "/%postname%/"],
  ], [1700, 2600, 4726], { size: 16 }),
  P("Security notes:"),
  ...bullets([
    "**Visitor IPs:** they appear only as MD5 hashes in transient names, and transients expire after one hour.",
    "**API key:** it is the one secret in the database. Only WordPress PHP and database administrators can read it.",
    "**Database access:** MariaDB is reachable only on the internal Docker network, with a random password generated on the VM.",
    "**Uninstall:** removes the plugin option and the daily counters.",
  ]),
);
add(
  H2("4.9 Other stores"),
  table(["Store", "Schema", "Notes"], [
    ["Browser localStorage", "uno_chat_session = random id (letters, digits, - and _)", "Sent with each question; replaced by New chat"],
    ["Langfuse Cloud", "Trace (name chat, session, user = visitor hash, input, output, metadata, tags) → observations (graph nodes, LLM generations with model and tokens, embedding call) → scores (user-feedback BOOLEAN; eval scores); datasets uno-rulebook-qa with items and experiment runs", "Written by the backend and the evaluation; nothing is read back by the app"],
    ["Caddy volumes", "caddy_data: certificates and ACME account; caddy_config: runtime config", "Kept across redeploys so certificates are not re-requested"],
    ["/opt/uno-wp/.env on the VM", "DB_PASSWORD, DB_ROOT_PASSWORD, SITE_DOMAIN, CF_IP_RANGES", "Mode 600, root only; generated on the VM"],
    ["Repository .env", "All settings in Appendix A", "Git-ignored; source of the Cloud Run environment"],
  ], [2000, 4700, 2326], { size: 16 }),
  P("Backup and restore:"),
  ...bullets([
    "**Search index:** rebuildable from the PDFs with `python -m app.ingest --reset`, so it needs no backup.",
    "**Backend caches and counters:** disposable.",
    "**WordPress:** back it up with VM disk snapshots, or `wp db export` inside the wpcli container.",
  ]),
);

// ---------------- 5. Retrieval ----------------
const retNames = { vector_only: "Vector only", bm25_only: "BM25 only", hybrid_rrf: "Hybrid (RRF)", bm25_title_filter: "BM25 + title filter", "hybrid_rrf_title_filter (production)": "Hybrid + title filter (production)" };
add(
  H1("5. Retrieval"),
  P(`Retrieval combines two searches, because each catches what the other misses (Figure ${fig("04_retrieval_pipeline.png")}). **Vector search** finds passages that mean the same thing as the question. **BM25 keyword search** finds exact card names and numbers, such as "Wild Draw Color" or "25 cards".`),
  figure("04_retrieval_pipeline.png", "Hybrid retrieval with reciprocal rank fusion", { scale: 0.6, maxH: 640 }),
  ...steps([
    "**Rulebook filter:** if the standalone question names an edition (an alias such as \"flip\", \"no mercy\" or \"classic\"), both searches are restricted to that PDF.",
    "**Two searches:** each returns up to 18 candidates (3 × TOP_K). The query embedding uses the prefix `task: search result | query: ` and is cached in SQLite, so repeated questions cost no embedding request.",
    "**Reciprocal rank fusion:** every chunk scores Σ 1 / (60 + rank) over the two result lists. Chunks found by both searches rise to the top.",
    "**Top 6** chunks (TOP_K) go to the answer node with their rulebook and page.",
  ]),
  P("`RETRIEVAL_MODE=bm25` turns off the vector search, which saves the embedding request."),
  figure("chart_retrieval.png", "Retrieval quality by method (31 labelled questions)", { maxW: 560 }),
  table(["Method", "Hit@1", "Recall@3", "Recall@6", "MRR", "Avg time"],
    Object.entries(retNames).map(([k, name]) => [name, pct(RET[k]["source_hit@1"]), pct(RET[k]["context_recall@3"]), pct(RET[k]["context_recall@6"]), RET[k].mrr_gold.toFixed(3), `${RET[k].avg_latency_ms} ms`]),
    [3200, 1000, 1150, 1150, 1000, 1526], { right: [1, 2, 3, 4, 5] }),
  P("The column headings mean:"),
  ...bullets([
    "**Hit@1:** the correct rulebook is ranked first.",
    "**Recall@k:** the passage that contains the answer is among the first k results.",
    "**MRR:** the mean of 1 / rank of that passage.",
  ]),
  note(`Finding: pure vector search with gemini-embedding-2 reaches ${pct(RET.vector_only["context_recall@6"])} recall@6 and MRR ${RET.vector_only.mrr_gold.toFixed(3)}, above the production hybrid (${pct(PROD_RET["context_recall@6"])}, ${PROD_RET.mrr_gold.toFixed(3)}). End-to-end accuracy is already 100%, so the hybrid stays for robustness on exact card names. A vector-first fusion weight is a candidate improvement.`),
);

// ---------------- 6. Graph ----------------
add(
  H1("6. Conversation flow (LangGraph)"),
  P(`Each message runs through a small LangGraph state machine (Figure ${fig("05_langgraph_flow.png")}). The graph is compiled once at start-up with a MemorySaver checkpointer. The visitor's \`session_id\` is the thread id, so a conversation keeps its history across turns.`),
  figure("05_langgraph_flow.png", "LangGraph conversation flow", { scale: 0.62, maxH: 560 }),
  table(["Node", "Model", "What it does", "Model requests"], [
    ["analyze", "gemini-3.5-flash-lite (thinking: minimal), JSON output", "Classifies the message as chitchat, rulebook or off_topic; rewrites follow-ups into a standalone question (\"what about in Flip?\" → full question); drafts the small-talk reply. Unknown routes default to rulebook.", "1"],
    ["respond_direct", "–", "Returns the small-talk reply, or the fixed off-topic refusal.", "0"],
    ["retrieve", "gemini-embedding-2 (query)", "Hybrid search for the standalone question (section 5).", "0–1 (cached)"],
    ["answer", "gemini-3.5-flash (thinking: low), JSON output", "Answers only from the 6 chunks, returns found/answer/used chunk numbers; the used chunks become the sources. Numbers are quoted verbatim; Markdown is stripped.", "1"],
    ["rewrite_query", "gemini-3.5-flash-lite", "If nothing relevant was found, rephrases the search once (MAX_REWRITES = 1) and retrieves again.", "1 (rare)"],
  ], [1400, 2200, 4300, 1126], { size: 17 }),
  H2("6.1 State, memory and safeguards"),
  P("The graph state holds the following fields:"),
  ...bullets([
    "`messages`: the chat history.",
    "`question` and `standalone_question`.",
    "`route` and `reply`.",
    "`search_query`.",
    "`documents` and `used_documents`.",
    "`found` and `rewrites`.",
  ]),
  P("Safeguards in the flow:"),
  ...bullets([
    "**History:** the last 6 messages (HISTORY_WINDOW) are given to the router, so follow-ups are understood.",
    "**Follow-up guard:** a regular expression catches follow-ups (\"it\", \"that\", \"what about…\") that the router failed to rewrite, and keeps the previous topic in the search.",
    "**No guessing:** if no chunk answers the question, the reply is the fixed text \"I couldn't find that in the rulebooks…\" rather than an invented answer.",
    "**Off-topic:** questions unrelated to UNO get a fixed polite refusal, with no search and no answer model.",
    "**Cost:** small talk and off-topic messages cost 1 request; rulebook questions cost 3; a repeated first question costs 0 (answer cache).",
  ]),
);

// ---------------- 7. Chat lifecycle ----------------
add(
  H1("7. What happens when someone starts a chat"),
  P(`Figures ${fig("06a_chat_sequence_frontend.png")} and ${fig("06b_chat_sequence_backend.png")} (on the following landscape pages) trace one question from the visitor's browser to Gemini and back. The front-end half covers the browser, Cloudflare, Caddy and WordPress. The back-end half covers WordPress, FastAPI, LangGraph, Gemini and Langfuse.`),
  H2("7.1 Step by step"),
  ...steps([
    "**Page load:** WordPress renders the chat page. The plugin loads `chatbot.js` and passes it the REST URL, a fresh REST nonce, the title, welcome text and three suggested questions (`wp_localize_script`). The backend URL and key are not included.",
    "**Session:** the widget reads or creates a random session id in localStorage (`uno_chat_session`) and shows the welcome message and suggestion buttons.",
    "**Ask:** the visitor types a question (or clicks a suggestion). The widget POSTs `{question, session_id}` to `/wp-json/uno-chat/v1/ask` with the `X-WP-Nonce` header and shows a typing indicator.",
    "**Cloudflare:** terminates TLS, applies its DDoS protection and forwards the request to the VM over HTTPS, adding `CF-Connecting-IP` with the visitor's real IP.",
    "**Caddy:** takes the visitor IP from that header (only because the request came from a Cloudflare IP range), applies the per-IP limits (300 requests/minute overall, 20/minute for the chat API) and proxies to WordPress with `X-Real-IP`.",
    "**WordPress plugin:** checks the nonce and the question limits, then calls the backend server-side (checks listed below).",
    "**Backend:** checks the API key, the request body and the daily budget, or answers from the cache (checks listed below).",
    "**Graph:** analyze (Flash-Lite) → retrieve (hybrid search; the query embedding usually comes from the cache) → answer (Flash). Each step and model call is recorded in the turn's Langfuse trace, which is sent before the response ends.",
    "**Response:** FastAPI returns `{answer, sources[], cached, trace_id}`. The plugin passes it to the browser unchanged except for validation of the trace id.",
    "**Display:** the widget shows the answer as plain text (`textContent`, never HTML), source chips such as \"Uno No mercy.pdf · p.1\" and thumbs up/down buttons.",
    "**Follow-up:** the next question carries the same session id, so the router sees the history and rewrites the follow-up into a standalone question.",
    "**New chat:** creates a new session id and calls `/reset`, which makes the backend forget the old conversation (`DELETE /chat/{id}`).",
  ]),
  P("Checks made by the WordPress plugin (step 6):"),
  ...bullets([
    "The nonce must be valid (otherwise 403).",
    "At most 10 questions per hour per visitor IP.",
    "At most 300 questions per day for the whole site.",
    "The question must be 1–1000 characters, and the session id must contain only `A–Z a–z 0–9 _ -`.",
  ]),
  P("The plugin then calls `POST {backend}/chat` with `X-API-Key` and an anonymous visitor id: the first 16 characters of a salted hash of the IP."),
  P("Checks made by the backend (step 7):"),
  ...bullets([
    "The API key must match (otherwise 401).",
    "Pydantic validates the body (otherwise 422).",
    "The daily request budget must not be exhausted (otherwise 429).",
  ]),
  P("If this is the first turn of the session and the question was answered before, the cached answer is returned with no model calls."),
  landscape(figure("06a_chat_sequence_frontend.png", "Chat request: browser to WordPress", { land: true })),
  landscape(figure("06b_chat_sequence_backend.png", "Chat request: WordPress to the backend and Gemini", { land: true })),
  H2("7.2 Feedback"),
  P(`Clicking thumbs up or down sends the answer's \`trace_id\` through the same proxy. The backend stores it in Langfuse as the BOOLEAN score \`user-feedback\` on that answer's trace (Figure ${fig("07_feedback_sequence.png")}).`),
  figure("07_feedback_sequence.png", "Feedback flow", { scale: 0.5 }),
  H2("7.3 Typical timings (deployed)"),
  table(["Message type", "Median", "95th percentile", "Model requests"], [
    ["Small talk", sec(PR.chitchat.latency.p50_s), sec(PR.chitchat.latency.p95_s), "1"],
    ["Off-topic", sec(PR.off_topic.latency.p50_s), sec(PR.off_topic.latency.p95_s), "1"],
    ["Rulebook question", sec(PR.rag.latency.p50_s), sec(PR.rag.latency.p95_s), "3"],
    ["Follow-up (second turn)", sec(PR.follow_ups.latency.p50_s), sec(PR.follow_ups.latency.p95_s), "3"],
  ], [3200, 1800, 1900, 2126], { right: [1, 2, 3] }),
  P("These are measured at the Cloud Run API. Through WordPress and Cloudflare, add about 0.3–1 s. After about 15 idle minutes, Cloud Run starts a new instance, and the first request takes a few seconds longer."),
);

// ---------------- 8. Front end ----------------
add(
  H1("8. Front end (WordPress)"),
  P(`The public site is a standard WordPress installation. It uses the default block theme **Twenty Twenty-Five**, and all chatbot functionality comes from one custom plugin, **UNO Rulebook RAG Chatbot**. There are no third-party WordPress plugins. Figure ${fig("11_frontend_components.png")} shows how the pieces fit together.`),
  figure("11_frontend_components.png", "Front-end components", { scale: 0.55 }),
  H2("8.1 How the site was built"),
  ...steps([
    "**Plugin:** the plugin (PHP, JavaScript and CSS, no build step) was written in `wordpress/uno-rag-chatbot/`, and its widget and landing page were designed to match.",
    "**Install:** WordPress was installed and configured by script (`wp-cli`), locally in Docker and on the VM, so both sites are reproducible.",
    "**Pages:** `wordpress/setup/pages.php` creates the two pages below and the navigation menu.",
    "**Plugin settings:** the backend URL and API key are saved server-side by the deploy script.",
  ]),
  P("The pages and menu:"),
  ...bullets([
    "**Home** (`[uno_chatbot_home]`), set as the front page. It's a landing page that explains what the assistant does, which rulebooks it knows and how it works, with a \"Start chatting\" button.",
    "**UNO Rules Chat** (`/uno-rules-chat/`, `[uno_chatbot layout=\"page\"]`). It uses the full-width \"page-no-title\" template with the chat box.",
    "**Main menu**, which contains only Home, so the theme doesn't list every page.",
  ]),
  H2("8.2 Plugin internals"),
  table(["Part", "Implementation"], [
    ["Settings page", "Settings → UNO Chatbot: backend URL, API key (password field), title, welcome text, floating bubble, questions per visitor per hour, questions per day (site). Shows backend health and today's usage."],
    ["Shortcodes", "`[uno_chatbot]` (inline box; `layout=\"page\"` adds the page header), `[uno_chatbot_home]` (landing page)."],
    ["Floating bubble", "Optional chat bubble on every page except pages that already show the inline chat."],
    ["Script data", "`wp_localize_script` passes restUrl, nonce, texts and suggestions; never the backend URL or key."],
    ["REST routes", "`uno-chat/v1/ask`, `/feedback`, `/reset`, all POST, all protected by the WordPress REST nonce, with argument validation."],
    ["Limits", "Per-IP transients (10 questions/hour, 60 ratings/hour) and a site-wide daily counter in its own option, incremented atomically in SQL."],
    ["Backend calls", "`wp_remote_request` with `X-API-Key`, 90 s timeout; backend errors are mapped to friendly messages (502/429)."],
    ["Privacy", "The backend and Langfuse only get a salted hash of the visitor IP."],
    ["Uninstall", "Removes the settings and the daily counters."],
  ], [2000, 7026], { size: 17 }),
  H2("8.3 Chat widget behaviour (chatbot.js)"),
  ...bullets([
    "**Mounting:** mounts on every `[data-uno-chat]` element. The inline, page and floating layouts share one code path.",
    "**Header:** an avatar, the title and the subtitle \"Answers from 5 UNO rulebooks\", plus a **New chat** button.",
    "**Before the first question:** suggestion buttons; they disappear after the first question.",
    "**While waiting:** a typing indicator. Errors (rate limit, expired session, backend down) are shown as a red message bubble.",
    "**Rendering:** answers are inserted with `textContent`, so model output can never inject HTML or scripts.",
    "**Feedback:** source chips (rulebook · page) and thumbs up/down. Feedback is sent once per answer and confirmed with \"Thanks for the feedback!\".",
  ]),
  H2("8.4 Plugins, modules and libraries used"),
  table(["Component", "Version / source", "Used for"], [
    ["UNO Rulebook RAG Chatbot (custom WordPress plugin)", "1.6.0, this repository", "All chatbot features on the site"],
    ["Twenty Twenty-Five (WordPress theme)", "Bundled with WordPress", "Site layout, header, footer"],
    ["WordPress / PHP / Apache", "wordpress:php8.3-apache image", "Website runtime"],
    ["MariaDB", "mariadb:11 image", "WordPress database"],
    ["wp-cli", "wordpress:cli-php8.3 image", "Scripted install and configuration"],
    ["Caddy + caddy-ratelimit (github.com/mholt/caddy-ratelimit)", "caddy:2, built with xcaddy", "HTTPS, reverse proxy, per-IP rate limits"],
    ["Cloudflare (free plan)", "SaaS", "DNS, proxy, DDoS protection, TLS"],
    ["fastapi, uvicorn[standard]", "requirements.txt", "HTTP API and ASGI server"],
    ["langgraph, langchain-core", "requirements.txt", "Conversation graph, messages, prompts, checkpointer"],
    ["langchain-google-genai, google-genai", "≥ 4.4 / ≥ 2.20", "Gemini chat models and embeddings on Vertex AI"],
    ["chromadb, langchain-chroma", "requirements.txt", "Vector store"],
    ["rank_bm25", "requirements.txt", "Keyword search"],
    ["pdfplumber, langchain-text-splitters", "requirements.txt", "PDF extraction, chunking"],
    ["pydantic-settings", "requirements.txt", "Configuration from .env"],
    ["httpx", "requirements.txt", "HTTP client (evaluation, security checks)"],
    ["langfuse", "≥ 5", "Tracing, scores, datasets"],
    ["docx, mermaid (npm); playwright, matplotlib (Python)", "docs/tools only", "Building this report and its diagrams"],
  ], [3700, 2300, 3026], { size: 17 }),
);

// ---------------- 9. API ----------------
add(
  H1("9. Front-end ↔ back-end communication and APIs"),
  P("The browser never talks to the backend. All communication follows one path: **browser → Cloudflare → Caddy → WordPress REST API → (server-to-server) → FastAPI**. As a result:"),
  ...bullets([
    "the backend URL and its key stay on the WordPress server",
    "the site can apply its own limits before any model is called",
    "the backend needs no CORS configuration",
  ]),
  table(["Header", "Set by", "Purpose"], [
    ["X-WP-Nonce", "chatbot.js (value from the page)", "Proves the request comes from a page WordPress served recently (CSRF protection)"],
    ["CF-Connecting-IP", "Cloudflare", "Real visitor IP; Caddy trusts it only from Cloudflare's ranges, and Cloudflare rejects client-supplied values"],
    ["X-Real-IP", "Caddy", "Visitor IP passed to WordPress (overwrites any client value); used for per-IP limits"],
    ["X-API-Key", "WordPress plugin (server-side)", "Shared secret required by every backend data endpoint"],
  ], [2000, 2600, 4426], { size: 17 }),
  H2("9.1 WordPress REST API (namespace uno-chat/v1)"),
  table(["Endpoint", "Request body", "Validation and limits", "Response"], [
    ["POST /ask", "{question, session_id}", "Nonce; question 1–1000 chars; session_id [A-Za-z0-9_-]{1,100}; 10/hour per IP; 300/day site-wide", "{answer, sources[{source,page}], cached, trace_id}"],
    ["POST /feedback", "{trace_id, value}", "Nonce; trace_id 32 hex chars; value 1 or -1; 60/hour per IP", "{ok: true}"],
    ["POST /reset", "{session_id}", "Nonce; session_id format", "{ok: true} (backend forgets the conversation)"],
  ], [1500, 1900, 3500, 2126], { size: 17 }),
  H2("9.2 Backend API (FastAPI on Cloud Run)"),
  table(["Endpoint", "Auth", "Request", "Response"], [
    ["GET /", "–", "–", "{service, health, docs}"],
    ["GET /health", "–", "–", "status, Gemini status and models, requests_today, daily_request_budget, documents_in_collection, Langfuse status (no secrets)"],
    ["POST /chat", "X-API-Key", "{question: 1–1000 chars, session_id ≤ 100, visitor? ≤ 64}", "{answer, sources[{source, page}], cached, trace_id}"],
    ["POST /feedback", "X-API-Key", "{trace_id: 32 hex, value: 1 | -1, comment? ≤ 500}", "204 No Content (Langfuse score user-feedback)"],
    ["DELETE /chat/{session_id}", "X-API-Key", "–", "{cleared: session_id}"],
    ["POST /ingest", "X-API-Key", "{reset: bool}", "{files, pages, chunks, collection_count}"],
    ["GET /docs, /openapi.json", "–", "–", "Interactive API documentation (schema only)"],
  ], [1900, 1100, 3000, 3026], { size: 17 }),
  H3("Example"),
  ...code([
    "POST /chat   X-API-Key: <secret>   Content-Type: application/json",
    "{\"question\": \"What is the Mercy rule in UNO No Mercy?\", \"session_id\": \"7f3c…\", \"visitor\": \"a91be2…\"}",
    "",
    "200 OK",
    "{\"answer\": \"According to the Uno No Mercy rulebook, if a player ever has 25 or more cards in their hand, they are out of the game …\",",
    " \"sources\": [{\"source\": \"Uno No mercy.pdf\", \"page\": 1}], \"cached\": false, \"trace_id\": \"5d0c…e41a\"}",
  ]),
  H2("9.3 Status codes across the layers"),
  table(["Code", "Returned by", "Meaning", "What the visitor sees"], [
    ["403", "Cloudflare", "Forged CF-Connecting-IP (error 1000) or a Cloudflare security rule", "Cloudflare error page"],
    ["429", "Caddy", "Per-IP limit (300/min site, 20/min chat API, 5/min login), with Retry-After", "Error message in the widget"],
    ["403", "WordPress", "Missing/expired nonce", "\"Your session expired. Please reload the page.\""],
    ["429", "WordPress", "10 questions/hour per IP, or 300/day site-wide", "\"You have reached the question limit for this hour…\" / \"…today's question limit…\""],
    ["401", "Backend", "Missing or wrong X-API-Key", "Generic \"could not answer\" (logged in WordPress)"],
    ["422", "Backend", "Invalid request body", "Generic error"],
    ["429", "Backend", "Daily model-request budget reached", "\"The daily usage cap…\""],
    ["502", "Backend / WordPress", "Gemini failure or backend unreachable", "\"The chat service could not answer right now…\""],
  ], [800, 1600, 3600, 3026], { size: 17 }),
);

// ---------------- 10. Security ----------------
const secRows = S.checks.map((c) => [c.result, c.area, c.check, c.observed]);
add(
  H1("10. Security"),
  P(`Security is layered, so no single control has to be perfect (Figure ${fig("09_security_layers.png")}). An attacker would have to get past Cloudflare, the firewall, Caddy's limits, WordPress's nonce and limits, and the backend's key before any model is called. Even then, the backend's daily budget caps the cost.`),
  figure("09_security_layers.png", "Security layers from the edge to the model", { scale: 0.62, maxH: 620 }),
  H2("10.1 How API keys and secrets are protected"),
  figure("08_api_key_flow.png", "Where secrets live and how they move", { scale: 0.55 }),
  table(["Secret", "Stored in", "Readable by", "How it gets there"], [
    ["BACKEND_API_KEY", "`.env` (git-ignored); Cloud Run env vars; WordPress option in MariaDB", "The developer; the Cloud Run container; WordPress PHP", "make_env.py file (deleted after deploy); deploy bundle (deleted on PC and VM, key passed to wp-cli on stdin, never on a command line)"],
    ["Langfuse public/secret key", "`.env`; Cloud Run env vars", "The developer; the container", "Same env file as above"],
    ["Google credentials", "None stored: Cloud Run uses the service account's short-lived tokens from the metadata server; locally `gcloud auth application-default login`", "Google infrastructure", "Attached service account uno-rag-backend@ (role Vertex AI User only)"],
    ["Database passwords", "/opt/uno-wp/.env on the VM (mode 600, root only)", "Root on the VM; containers", "Generated on the VM with openssl, never leave it"],
    ["WordPress admin password", "Hashed in WordPress; plain copy in /opt/uno-wp/admin-credentials.txt (root only) and wordpress/admin-credentials-gcp.txt (git-ignored)", "Root on the VM; the developer", "Generated on the VM at install"],
  ], [1700, 2900, 1800, 2626], { size: 16 }),
  P("Additional safeguards:"),
  ...bullets([
    "**Browser:** the browser only ever receives a WordPress nonce. The page HTML contains neither the key nor the backend address, which the security checks verify.",
    "**/health:** returns model and status information but never configuration secrets, which is also verified.",
    "**Evaluation config:** the evaluation results store the configuration without any setting whose name contains KEY.",
    "**Uploads:** `.gcloudignore` and `.dockerignore` keep `.env` and `.venv` out of the Cloud Run upload and the image. The upload list was checked: 24 files.",
  ]),
  H2("10.2 Network and DDoS protection"),
  ...bullets([
    "**Cloudflare proxy:** the DNS record is proxied (orange cloud), so visitors connect to Cloudflare's network. Volumetric attacks are absorbed there.",
    "**Origin lock-down:** the firewall rule `uno-wp-web` admits ports 80/443 only from Cloudflare's published IP ranges, fetched at deploy time. The VM's own IP doesn't answer web requests from anywhere else, so the protection can't be bypassed.",
    "**Encryption end to end:** Cloudflare SSL/TLS mode is Full (strict), so Cloudflare verifies the origin certificate. Caddy obtains and renews a Let's Encrypt certificate (HTTP-01 validation passes through Cloudflare). http requests are redirected to https.",
    "**Backend:** Cloud Run is a Google-managed HTTPS endpoint. It's public, but every data endpoint requires the API key, and it runs at most one instance, which caps cost.",
  ]),
  H2("10.3 Rate limiting"),
  figure("10_rate_limiting_flow.png", "Rate-limiting decisions for one request", { scale: 0.62, maxH: 600 }),
  table(["Layer", "Limit", "Key", "Response"], [
    ["Caddy zone `site`", "300 requests / minute", "Visitor IP", "429 + Retry-After"],
    ["Caddy zone `chat`", "20 requests / minute to /wp-json/uno-chat/*", "Visitor IP", "429 + Retry-After"],
    ["Caddy zone `login`", "5 POST /wp-login.php / minute", "Visitor IP", "429 + Retry-After"],
    ["Plugin", "10 questions / hour (setting)", "Visitor IP", "429 friendly message"],
    ["Plugin", "60 ratings / hour", "Visitor IP", "429"],
    ["Plugin", "300 questions / day, whole site (setting)", "UTC date", "429 \"today's limit\""],
    ["Backend", "2000 model requests / day", "Instance", "429 daily cap"],
  ], [1900, 3600, 1400, 2126], { size: 17 }),
  note("The backend's daily counter lives in the Cloud Run instance's temporary storage. It resets when the instance restarts, about 15 minutes after the last request. The site-wide daily cap in WordPress is kept in MariaDB, so it is the limit that really holds; 300 questions a day is about 900 model requests at most."),
  H2("10.4 Real visitor IPs and spoofing"),
  P("Per-IP limits only work if the IP can't be faked. Behind proxies there are three possible sources:"),
  ...bullets([
    "**The TCP connection:** always Cloudflare.",
    "`CF-Connecting-IP`: set by Cloudflare.",
    "`X-Forwarded-For` / `X-Real-IP`: these can be sent by anyone.",
  ]),
  P("The defences:"),
  ...bullets([
    "Caddy's `trusted_proxies` lists only Cloudflare's ranges, and `client_ip_headers` is `CF-Connecting-IP`. A request that doesn't come from Cloudflare can't choose its IP.",
    "Cloudflare itself rejects requests that try to send their own `CF-Connecting-IP` (error 1000).",
    "Caddy sets `X-Real-IP` to the resolved visitor IP and overwrites any client value. WordPress copies it to `REMOTE_ADDR`, so the plugin's limits use the real IP.",
    "This was tested: 25 chat-API calls with random spoofed `X-Forwarded-For`, `X-Real-IP` and `True-Client-IP` values still hit the 429 at the 21st request in the minute.",
  ]),
  H2("10.5 Application hardening"),
  ...bullets([
    "**WordPress REST nonce** on every chat route (CSRF protection), plus strict argument validation (length, character set, enum).",
    "**Output encoding:** the widget renders model answers with `textContent`. Admin settings are escaped (`esc_attr`, `esc_html`) and sanitized on save.",
    "**WordPress hardening:** `DISALLOW_FILE_EDIT` (no theme/plugin editor), `xmlrpc.php` blocked by Caddy, the plugin folder mounted read-only, the WordPress container not published to the internet (only Caddy is).",
    "**Backend validation:** Pydantic schemas reject oversized or malformed input before any model call (question ≤ 1000 chars, trace id format, feedback value).",
    "**Containers:** the backend runs as a non-root user on python:3.13-slim. Container logs are capped (10 MB × 3) so floods can't fill the disk. MariaDB is reachable only on the internal Docker network.",
    "**Grounding:** the answer prompt allows only the retrieved passages, and off-topic requests get a fixed refusal. This limits prompt-injection impact to the rulebook domain.",
  ]),
  H2("10.6 Identity and least privilege"),
  ...bullets([
    "**Cloud Run service account:** `uno-rag-backend@uno-rag-chatbot.iam.gserviceaccount.com` has only **Vertex AI User**. No service-account key exists.",
    "**VM:** uses the default compute account with the minimal scopes `logging-write` and `monitoring-write`, so the VM can't call other Google APIs.",
    "**Deploy-time permission grants** (IAM) are a separate, skippable step (`-SkipIamGrants`), so routine updates never change permissions.",
  ]),
  H2("10.7 Privacy"),
  ...bullets([
    "**Backend and Langfuse:** visitors are identified only by a 16-character salted hash of their IP. Raw IPs never leave the VM.",
    "**Caddy logs:** the access log contains IPs for abuse investigation and is size-capped.",
    "**Content:** no account, name or email is collected from visitors. Chat content is stored in Langfuse traces for quality monitoring.",
  ]),
  H2("10.8 Threats and mitigations"),
  table(["Threat", "Mitigation"], [
    ["Stolen backend key from the browser", "Key never sent to the browser; only server-to-server"],
    ["Direct calls to the backend", "X-API-Key required; 401 otherwise; daily budget caps cost"],
    ["DDoS / traffic floods on the site", "Cloudflare proxy; firewall admits only Cloudflare; Caddy 300 requests/min per IP; log caps"],
    ["Bypassing Cloudflare via the origin IP", "Firewall rule limited to Cloudflare ranges (origin unreachable, verified)"],
    ["Credit exhaustion by scripted questions", "Caddy 20/min, plugin 10/hour per IP, 300/day site-wide, backend 2000/day, max 1 Cloud Run instance"],
    ["IP spoofing to escape limits", "Trusted-proxy configuration, header overwrite, Cloudflare error 1000 (verified)"],
    ["Password guessing on wp-admin", "5 login POSTs/minute per IP; strong random admin password; xmlrpc blocked"],
    ["Cross-site request forgery on chat routes", "WordPress REST nonce"],
    ["HTML/script injection via model output", "textContent rendering; Markdown stripped"],
    ["Secrets leaking through deploy artefacts", "Generated env files and bundles deleted; ignore files checked; .env git-ignored"],
    ["Cloud credential theft", "No key files; least-privilege service account; minimal VM scopes"],
  ], [3300, 5726], { size: 17 }),
  H2("10.9 Security test results"),
  P(`\`python -m eval.security_checks\` ran against the live system on ${S.run_at}: **${S.summary.PASS} passed, ${S.summary.FAIL} failed, ${S.summary.INFO} informational**.`),
  table(["Result", "Area", "Check", "Observed"], secRows, [800, 1100, 4200, 2926], { size: 15 }),
  H2("10.10 Known limitations and recommendations"),
  ...bullets([
    "**Security headers:** HSTS, `X-Content-Type-Options` and `X-Frame-Options` aren't set yet. Add them in Caddy (or as a Cloudflare transform rule).",
    "**Secrets:** they are plain environment variables (by choice). For stricter control, move `BACKEND_API_KEY` and the Langfuse keys to Secret Manager.",
    "**SSH:** port 22 on the VM is open to the internet (default rule; key-based login only). Restrict it to Google's IAP range and use `gcloud compute ssh --tunnel-through-iap`.",
    "**Backend budget:** it resets per instance (section 10.3); a persistent counter (Firestore) would make it exact.",
    "**IPv6 visitors:** an IPv6 visitor can rotate addresses within their /64 block. Keying the Caddy limits on the /64 prefix would close this.",
    "**API docs:** `/docs` is public (schema only). Disable it in production if the API surface should not be advertised.",
    "**Backups:** schedule weekly snapshots of the VM disk.",
  ]),
);

// ---------------- 11. Deployment ----------------
add(
  H1("11. Deployment"),
  P(`Production runs in the Google Cloud project \`uno-rag-chatbot\` behind the Cloudflare zone \`buildwithmayank.tech\` (Figure ${fig("02_deployment_topology.png")}). Two idempotent PowerShell scripts deploy everything from the developer's Windows PC. They are safe to re-run, and each run is also an update.`),
  figure("02_deployment_topology.png", "Deployment topology", { scale: 0.52 }),
  landscape(H2("11.1 Backend on Cloud Run"),
    figure("12_deploy_backend.png", "Backend deployment workflow (deploy/cloudrun/deploy.ps1)", { land: true })),
  table(["Setting", "Value", "Why"], [
    ["Region", "us-central1", "Low latency to the VM; Vertex AI location is global"],
    ["CPU / memory", "1 vCPU / 1 GiB", "Enough for FastAPI + Chroma with 60 chunks"],
    ["Instances", "min 0, max 1", "Free when idle; one instance caps cost and keeps memory/caches consistent"],
    ["Concurrency / timeout", "20 requests / 120 s", "Model calls are I/O-bound; 120 s covers retries"],
    ["CPU boost", "on", "Faster cold starts"],
    ["Identity", "service account uno-rag-backend@ (Vertex AI User)", "No key file needed"],
    ["Ingress / auth", "public, --allow-unauthenticated", "Protected by X-API-Key instead of Google IAM (WordPress isn't a Google identity)"],
    ["Image", "python:3.13-slim, non-root user, index + PDFs baked in", "Fast, deterministic start-up; no re-embedding"],
    ["Env overrides", "CACHE_DIR=/tmp/uno-cache, CHROMA_DIR=/app/chroma_db, LANGFUSE_ENVIRONMENT=production, LANGFUSE_FLUSH_EACH_REQUEST=true", "Writable temp storage; traces sent before the response ends (CPU is throttled afterwards)"],
  ], [2000, 3700, 3326], { size: 17 }),
  landscape(H2("11.2 WordPress on Compute Engine"),
    figure("13_deploy_wordpress.png", "WordPress deployment workflow (deploy/wordpress/deploy.ps1)", { land: true })),
  table(["Item", "Value"], [
    ["VM", "uno-wordpress, e2-small (2 vCPU burst, 2 GB) + 1 GB swap, Debian 12, 20 GB pd-balanced, shielded secure boot, us-central1-a"],
    ["Network", "Static IP 34.57.222.238; firewall uno-wp-web: tcp 80/443 (+udp 443) from Cloudflare ranges only; tag uno-wp"],
    ["Containers (/opt/uno-wp)", "caddy (built with caddy-ratelimit, ports 80/443), wordpress:php8.3-apache (internal only), mariadb:11 (innodb buffer 128 MB, performance schema off), wpcli (tools profile)"],
    ["Volumes", "db_data, wp_data, caddy_data (certificates), caddy_config"],
    ["Configuration", "WORDPRESS_CONFIG_EXTRA: REMOTE_ADDR from X-Real-IP, DISALLOW_FILE_EDIT, WP_MEMORY_LIMIT 128M"],
    ["Updates", "Re-run deploy.ps1 -Domain …: new plugin files, settings kept, wordpress + caddy recreated (data in volumes)"],
  ], [2100, 6926], { size: 17 }),
  H2("11.3 Cloudflare configuration"),
  ...steps([
    "**DNS → Records:** an A record `uno-chatbot` → 34.57.222.238 with Proxy status **Proxied** (orange cloud).",
    "**SSL/TLS → Overview:** encryption mode **Full (strict)**. Flexible causes a redirect loop, because Caddy redirects http to https.",
    "**Optional:** Security → Bots → Bot Fight Mode, and a WAF rate-limiting rule (the free plan includes one).",
  ]),
  H2("11.4 Updates and rollback"),
  table(["Change", "Command / action"], [
    ["Backend code or settings", "`deploy\\cloudrun\\deploy.ps1 -SkipIamGrants` (new revision)"],
    ["New or changed PDFs", "`python -m app.ingest --reset`, run the evaluation, then deploy the backend"],
    ["Plugin or site setup", "`deploy\\wordpress\\deploy.ps1 -Domain uno-chatbot.buildwithmayank.tech`"],
    ["Backend rollback", "`gcloud run services update-traffic uno-rag-backend --region us-central1 --to-revisions <revision>=100`"],
    ["Site rollback / recovery", "Restore the VM disk snapshot, or redeploy the previous plugin version"],
  ], [2600, 6426], { size: 17 }),
  H2("11.5 Cost"),
  table(["Item", "Monthly cost (approx.)"], [
    ["VM e2-small", "$13"],
    ["Static IP", "$3 (also billed while the VM is stopped)"],
    ["20 GB balanced disk", "$2"],
    ["Cloud Run", "$0 (free tier at this traffic)"],
    ["Cloud Build + Artifact Registry", "a few cents"],
    ["Gemini (pay per use)", "a fraction of a cent per question; a full evaluation run of ~100 requests costs a few cents"],
    ["Cloudflare free plan, Langfuse Hobby", "$0"],
  ], [3500, 5526]),
);

// ---------------- 12. Observability ----------------
add(
  H1("12. Monitoring and observability"),
  P("When the Langfuse keys are set, the backend records one trace per chat turn. Without them, the chat works the same and nothing is sent."),
  ...bullets([
    "**Trace** `chat`, one per turn:",
    ["**Grouping:** the session (the conversation) and the user (the anonymous visitor hash).", 1],
    ["**Input and output:** the question as input; the answer and sources as output.", 1],
    ["**Metadata:** route, found, rewrites, standalone question, cached, the models, and the requests used today.", 1],
    "**Child observations:** every graph node, every Gemini call (with the actual model, tokens and latency), the query embedding and the retrieved chunks, via the LangChain callback handler.",
    "**Tags:** `route:rulebook`, `route:chitchat`, `route:off_topic`, `cached`, `refused`, `daily-limit` and `error`, for filtering and dashboards.",
    "**Environments:** `local` (development), `production` (Cloud Run) and `eval` (evaluation runs).",
    "**Scores:** `user-feedback` (BOOLEAN) from the widget's thumbs. The evaluation adds `answer_correct`, `citation_correct`, `route_correct` and `requests_used` in experiments on the dataset `uno-rulebook-qa`, plus per-method retrieval scores.",
    "**Serverless delivery:** on Cloud Run each request flushes its trace before returning, because the CPU is throttled after the response.",
  ]),
  P("Operational logs:"),
  ...bullets([
    "**Cloud Run:** `gcloud run services logs read uno-rag-backend --region us-central1`.",
    "**VM:** `sudo docker compose logs caddy|wordpress|db` (Caddy logs JSON access lines with the visitor IP and status).",
    "**Usage:** the plugin settings page shows backend health, requests used today and site questions today.",
  ]),
);

// ---------------- 13. Evaluation ----------------
const evoRows = [
  ["Rulebook answers correct", `${pct(BE.rag.answer_accuracy)}`, pct(E.rag.accuracy), pct(PR.rag.accuracy)],
  ["Correct rulebook cited", pct(BE.rag.citation_accuracy), pct(E.rag.citation_accuracy), pct(PR.rag.citation_accuracy)],
  ["False refusals", String(BE.rag.false_refusals), String(E.rag.false_refusals), String(PR.rag.false_refusals)],
  ["Follow-ups correct", pct(BE.follow_ups.answer_accuracy), pct(E.follow_ups.accuracy), pct(PR.follow_ups.accuracy)],
  ["Off-topic refused", pct(BE.off_topic.correct_refusal_rate), pct(E.off_topic.accuracy), pct(PR.off_topic.accuracy)],
  ["Median time, rulebook question", sec(BE.rag.latency.p50_s), sec(E.rag.latency.p50_s), sec(PR.rag.latency.p50_s)],
  ["Answer chunk in top 6 (production retrieval)", pct(B.retrieval["hybrid_rrf_title_filter (production)"]["context_recall@6"]), pct(PROD_RET["context_recall@6"]), "same index"],
  ["MRR of the answer chunk", B.retrieval["hybrid_rrf_title_filter (production)"].mrr_gold.toFixed(3), PROD_RET.mrr_gold.toFixed(3), "same index"],
];
add(
  H1("13. Evaluation"),
  P("The evaluation uses a hand-labelled test set written against the extracted rulebook text (`eval/dataset.py`):"),
  ...bullets([
    "**31 rulebook questions:** each lists the facts the answer must contain (for example \"25\" for the Mercy rule) and the correct source PDF.",
    "**6 off-topic questions:** these must be refused without sources.",
    "**16 small-talk messages:** these must be answered without retrieval.",
    "**4 two-turn conversations:** the second question only makes sense with the first.",
  ]),
  P("Three runs measure the system:"),
  ...bullets([
    "**Local:** retrieval metrics and end-to-end answers on the local graph, also logged as a Langfuse experiment.",
    "**Production:** the same questions over HTTPS against the deployed Cloud Run API.",
    "**Security:** automated checks of the live security measures (section 10.9).",
  ]),
  ...code([
    "python -m eval.run_eval                     # -> eval/results_gemini.json",
    "python -m eval.run_eval --backend-url URL   # -> eval/results_production.json",
    "python -m eval.security_checks              # -> eval/results_security.json",
  ]),
  H2("13.1 Retrieval"),
  P(`See section 5 for the method comparison. With the production hybrid search and rulebook filter, the correct rulebook is ranked first for ${pct(PROD_RET["source_hit@1"])} of questions, and the passage containing the answer is in the top 6 for ${pct(PROD_RET["context_recall@6"])}.`),
  H2("13.2 End-to-end accuracy"),
  figure("chart_accuracy.png", "End-to-end accuracy: first version vs. current system (local and deployed)", { maxW: 560 }),
  table(["Group", "Local graph", "Deployed API", "How it is scored"], [
    ["Rulebook questions", `${nOk(E.rag)}/${E.rag.n} (${pct(E.rag.accuracy)})`, `${nOk(PR.rag)}/${PR.rag.n} (${pct(PR.rag.accuracy)})`, "Every required fact appears in the answer"],
    ["Correct citation", pct(E.rag.citation_accuracy), pct(PR.rag.citation_accuracy), "A source chip names the correct PDF"],
    ["Off-topic", `${nOk(E.off_topic)}/${E.off_topic.n}`, `${nOk(PR.off_topic)}/${PR.off_topic.n}`, "Refusal text and no sources"],
    ["Small talk", `${nOk(E.chitchat)}/${E.chitchat.n}`, `${nOk(PR.chitchat)}/${PR.chitchat.n}`, "Answered without retrieval or refusal"],
    ["Follow-ups", `${nOk(E.follow_ups)}/${E.follow_ups.n}`, `${nOk(PR.follow_ups)}/${PR.follow_ups.n}`, "Second answer contains the required facts"],
    ["Routing (local only)", pct(E.rag.route_accuracy), "–", "Router chose the expected route"],
  ], [2000, 1900, 1900, 3226], { size: 17 }),
  H2("13.3 Latency"),
  figure("chart_latency.png", "Answer latency by message type", { maxW: 560 }),
  P(`Medians are stable: ${sec(E.rag.latency.p50_s)} locally and ${sec(PR.rag.latency.p50_s)} on Cloud Run for rulebook questions, and about 1 s for small talk. ${prodCached === 0 ? "None of the production answers came from the answer cache" : `Only ${prodCached} of the ${PR.details.length} production answers came from the answer cache`}, so these are real model latencies.`),
  P(`The 95th percentiles are dominated by a few slow calls on the model side. The slowest answers took ${sec(E.rag.latency.max_s)} locally and ${sec(PR.rag.latency.max_s)} on Cloud Run. During the local run, Vertex AI answered one request with HTTP 429 (shared capacity), and the backend retried it after 5 seconds; other slow calls were queued at Vertex AI. The backend's retry logic absorbs these without failing the answer.`),
  H2("13.4 Project evolution"),
  P("The first version (October 2026) ran entirely on the developer's PC with Ollama (qwen3.5:9b for answers, nomic-embed-text for embeddings). The current version uses Gemini on Vertex AI and was redesigned in two ways:"),
  ...bullets([
    "**One router call** replaced the separate classify, contextualize and grade steps.",
    "**Retrieval** gained the contextual rulebook header and query caching.",
  ]),
  table(["Measure", "v1 Ollama (local)", "v2 Gemini (local)", "v2 Gemini (deployed)"], evoRows, [3400, 1800, 1800, 2026], { size: 17, right: [1, 2, 3] }),
);

// ---------------- 14. Setup from scratch ----------------
add(
  H1("14. Setting up the project from scratch"),
  P(`Figure ${fig("14_setup_from_scratch.png")} (after the prerequisites) shows the order of the setup steps; the commands below are complete.`),
  H2("14.1 Prerequisites"),
  table(["Need", "Notes"], [
    ["Windows 10/11 PC with PowerShell", "The deploy scripts are PowerShell; the VM script is bash and runs on the VM"],
    ["Python 3.13", "Backend, ingest, evaluation"],
    ["Docker Desktop", "Local WordPress (and optional local container test)"],
    ["Google Cloud SDK (gcloud)", "Logged in with `gcloud auth login` and `gcloud auth application-default login`"],
    ["Google Cloud project with billing", "Trial credits work; the deploy script enables the needed APIs"],
    ["A domain on Cloudflare (free plan)", "For the public site; a subdomain is enough"],
    ["Langfuse Cloud account (optional)", "Free Hobby plan; project API keys"],
    ["Node.js (optional)", "Only to rebuild this report"],
  ], [3300, 5726], { size: 17 }),
  landscape(figure("14_setup_from_scratch.png", "Setup from scratch", { land: true })),
  H2("14.2 Local backend"),
  ...code([
    "python -m venv .venv",
    ".venv\\Scripts\\activate",
    "pip install -r requirements.txt",
    "copy .env.example .env",
    "#   edit .env: GOOGLE_CLOUD_PROJECT=<project id>",
    "#              BACKEND_API_KEY=<long random string>",
    "#              LANGFUSE_* keys (optional)",
    "gcloud auth application-default login",
    "gcloud services enable aiplatform.googleapis.com --project <project id>",
    "python -m app.model_status          # checks the Gemini models (free)",
    "python -m app.ingest --reset        # builds chroma_db/ from Data/*.pdf",
    "python -m app.main                  # http://localhost:8000/health",
  ]),
  H2("14.3 Local WordPress"),
  ...code([
    "# Docker Desktop running",
    "powershell -ExecutionPolicy Bypass -File wordpress\\setup.ps1",
    "#   -> http://localhost:8080, chat at /uno-rules-chat/",
    "#      admin login in wordpress\\admin-credentials.txt",
    "python -m eval.run_eval              # optional: accuracy check (~100 Gemini requests)",
  ]),
  H2("14.4 Backend on Cloud Run"),
  ...code([
    "gcloud config set project <project id>",
    "powershell -ExecutionPolicy Bypass -File deploy\\cloudrun\\deploy.ps1",
    "#   prints the service URL; check  https://<service>/health",
    "#   later updates:  deploy\\cloudrun\\deploy.ps1 -SkipIamGrants",
  ]),
  P("The first deploy creates the service account and grants it Vertex AI User. On new projects it also lets the default compute account run source builds. If the first build fails with a permission error, wait two minutes for the grant to apply and run the script again."),
  H2("14.5 WordPress on Compute Engine with Cloudflare"),
  ...code([
    "powershell -ExecutionPolicy Bypass -File deploy\\wordpress\\deploy.ps1",
    "#   creates static IP + firewall + VM and prints the IP",
    "# Cloudflare: DNS A record <name> -> <IP>, Proxied; SSL/TLS mode Full (strict)",
    "powershell -ExecutionPolicy Bypass -File deploy\\wordpress\\deploy.ps1 -Domain <domain>",
    "#   installs everything, then locks the firewall to Cloudflare",
    "#   admin login saved to wordpress\\admin-credentials-gcp.txt",
  ]),
  H2("14.6 Verify"),
  ...code([
    "python -m eval.run_eval --backend-url https://<service>.run.app",
    "python -m eval.security_checks --site https://<domain> \\",
    "    --backend https://<service>.run.app --origin-ip <VM IP>",
  ]),
  P("Then open the site, ask a question and rate the answer. Check that the trace and the `user-feedback` score appear in Langfuse."),
);

// ---------------- 15. Operations ----------------
add(
  H1("15. Operations and troubleshooting"),
  table(["Task", "Command"], [
    ["Backend health", "`curl https://<service>/health`"],
    ["Backend logs", "`gcloud run services logs read uno-rag-backend --region us-central1`"],
    ["SSH to the VM", "`gcloud compute ssh uno-wordpress --zone us-central1-a`"],
    ["Site logs / status", "`cd /opt/uno-wp && sudo docker compose ps` / `logs -f caddy`"],
    ["Blocked requests", "`sudo docker compose logs caddy | grep '\"status\":429'`"],
    ["Stop / start the VM", "`gcloud compute instances stop|start uno-wordpress --zone us-central1-a`"],
    ["Plugin limits and usage", "WordPress → Settings → UNO Chatbot"],
  ], [2600, 6426], { size: 17 }),
  table(["Symptom", "Cause", "Fix"], [
    ["\"Your session expired\" (403)", "Old nonce in a cached page", "Reload; exclude the chat page from full-page caching"],
    ["\"question limit for this hour / today\" (429)", "Plugin limits reached", "Wait, or raise them in the settings"],
    ["429 with Retry-After on pages", "Caddy per-IP limit", "Wait one minute"],
    ["Too many redirects", "Cloudflare SSL mode Flexible", "Set Full (strict)"],
    ["Cloudflare 521/522", "VM stopped or firewall wrong", "Start the VM; re-run the WordPress deploy"],
    ["Raw shortcode text on the site", "Plugin files not visible in the container", "Re-run the WordPress deploy (recreates the containers)"],
    ["\"Backend not reachable\" in settings", "Wrong URL or cold start", "Check the URL; retry after a few seconds"],
    ["Backend 401 in WordPress logs", "Keys differ", "Re-run the WordPress deploy (copies the key from .env)"],
    ["Backend 502", "Gemini auth/quota", "`/health` → gemini.ok; check credentials and quotas"],
  ], [2700, 2600, 3726], { size: 17 }),
);

// ---------------- Appendix A: configuration ----------------
add(
  H1("Appendix A. Configuration reference (.env)"),
  table(["Setting", "Default", "Description"], [
    ["GOOGLE_CLOUD_PROJECT", "–", "Google Cloud project for Vertex AI"],
    ["GOOGLE_CLOUD_LOCATION", "global", "Vertex AI location"],
    ["GOOGLE_APPLICATION_CREDENTIALS", "empty", "Optional key file; empty = Application Default Credentials"],
    ["ROUTER_MODEL / ROUTER_THINKING", "gemini-3.5-flash-lite / minimal", "Routing, follow-up rewriting, small talk, query rewrite"],
    ["ANSWER_MODEL / ANSWER_THINKING", "gemini-3.5-flash / low", "Grounded answers"],
    ["LLM_TEMPERATURE / LLM_MAX_TOKENS", "0.1 / 2000", "Sampling (ignored by Flash-Lite) and output limit incl. thinking"],
    ["EMBED_MODEL / EMBED_DIMENSIONS", "gemini-embedding-2 / 768", "Embedding model and vector size"],
    ["EMBED_QUERY_PREFIX / EMBED_DOC_PREFIX", "task: search result | query: / title: none | text: ", "Task prefixes for gemini-embedding-2"],
    ["EMBED_CONCURRENCY", "8", "Parallel embedding requests during ingest"],
    ["DAILY_REQUEST_BUDGET", "2000", "Model requests per UTC day before 429"],
    ["ANSWER_CACHE / CACHE_DIR", "true / cache", "First-turn answer cache and its folder"],
    ["DATA_DIR / CHROMA_DIR / COLLECTION_NAME", "Data / chroma_db / uno_docs_gemini", "Inputs and index"],
    ["CHUNK_SIZE / CHUNK_OVERLAP", "1000 / 150", "Chunking"],
    ["TOP_K / MAX_REWRITES / HISTORY_WINDOW", "6 / 1 / 6", "Chunks per answer, query retries, history messages"],
    ["RETRIEVAL_MODE", "hybrid", "hybrid or bm25 (no query embedding)"],
    ["BACKEND_API_KEY", "–", "Shared secret for X-API-Key"],
    ["LANGFUSE_PUBLIC_KEY / SECRET_KEY / BASE_URL", "empty / empty / https://cloud.langfuse.com", "Monitoring (off when keys are empty)"],
    ["LANGFUSE_ENVIRONMENT / LANGFUSE_FLUSH_EACH_REQUEST", "local / false", "production / true on Cloud Run"],
    ["API_HOST / API_PORT", "0.0.0.0 / 8000", "Local server (Cloud Run uses $PORT)"],
    ["AUTO_INGEST_ON_STARTUP / LOG_LEVEL", "true / INFO", "Ingest when the collection is empty; logging"],
  ], [3300, 2600, 3126], { size: 16 }),
);

// ---------------- Appendix B: per-question results ----------------
const prodByQ = Object.fromEntries(PR.details.map((d) => [d.q, d]));
const detailRows = E.details.map((d, i) => {
  const p = prodByQ[d.q] || {};
  const tick = (x) => (x === undefined ? "–" : x ? "✔" : "✘");
  return [String(i + 1), d.q, tick(d.correct), `${d.total_s.toFixed(1)}`, tick(p.correct), p.total_s !== undefined ? p.total_s.toFixed(1) : "–"];
});
add(
  H1("Appendix B. Per-question results"),
  P("Every end-to-end test case, run on the local graph and against the deployed API (✔ correct, ✘ wrong; times in seconds). Follow-ups show both turns."),
  table(["#", "Question", "Local", "s", "Deployed", "s"], detailRows, [450, 5600, 700, 700, 900, 676], { size: 15, right: [3, 5] }),
);

// ---------------- Appendix C: diagrams ----------------
add(
  H1("Appendix C. Diagram sources"),
  P("All diagrams are Mermaid files in `docs/diagrams/`, rendered to PNG by `docs/tools/render_diagrams.py`. The charts come from `docs/tools/charts.py` and the evaluation JSON files. To rebuild this report, run `node docs/tools/build_report.js`."),
  table(["File", "Figure", "Shows"], [
    ["01_architecture.mmd", fig("01_architecture.png"), "Components and how they connect"],
    ["02_deployment_topology.mmd", fig("02_deployment_topology.png"), "Cloudflare, Google Cloud resources, deploy paths"],
    ["03_ingestion_pipeline.mmd", fig("03_ingestion_pipeline.png"), "PDF to Chroma indexing steps"],
    ["04_retrieval_pipeline.mmd", fig("04_retrieval_pipeline.png"), "Hybrid search and reciprocal rank fusion"],
    ["05_langgraph_flow.mmd", fig("05_langgraph_flow.png"), "LangGraph nodes, routes and memory"],
    ["06a_chat_sequence_frontend.mmd", fig("06a_chat_sequence_frontend.png"), "Chat request from the browser to WordPress"],
    ["06b_chat_sequence_backend.mmd", fig("06b_chat_sequence_backend.png"), "Chat request from WordPress to Gemini"],
    ["07_feedback_sequence.mmd", fig("07_feedback_sequence.png"), "Thumbs up/down to a Langfuse score"],
    ["08_api_key_flow.mmd", fig("08_api_key_flow.png"), "Where secrets live and how they move"],
    ["09_security_layers.mmd", fig("09_security_layers.png"), "The six security layers"],
    ["10_rate_limiting_flow.mmd", fig("10_rate_limiting_flow.png"), "Rate-limit decisions per request"],
    ["11_frontend_components.mmd", fig("11_frontend_components.png"), "WordPress pages, plugin files and assets"],
    ["12_deploy_backend.mmd", fig("12_deploy_backend.png"), "Cloud Run deployment workflow"],
    ["13_deploy_wordpress.mmd", fig("13_deploy_wordpress.png"), "VM deployment workflow"],
    ["14_setup_from_scratch.mmd", fig("14_setup_from_scratch.png"), "Setup order from a new machine"],
    ["15_data_flow.mmd", fig("15_data_flow.png"), "Indexing and answering data flow"],
    ["16_chroma_schema.mmd", fig("16_chroma_schema.png"), "ChromaDB storage schema (entity-relationship)"],
    ["17_data_stores.mmd", fig("17_data_stores.png"), "All data stores and data movement"],
  ].map(([f, n, d]) => [`\`${f}\``, String(n), d]), [3600, 900, 4526], { size: 17 }),
);

// ---------------- document ----------------
const doc = new Document({
  creator: "Mayank Bisht",
  title: "UNO Rulebook RAG Chatbot - Technical Report",
  description: "Architecture, data flow, APIs, front end, security, deployment, setup and evaluation",
  features: { updateFields: true },
  styles: {
    default: { document: { run: { font: FONT, size: 21 } } },
    paragraphStyles: [
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 32, bold: true, color: DARK, font: FONT }, paragraph: { spacing: { before: 240, after: 160 }, outlineLevel: 0 } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 26, bold: true, color: BLUE, font: FONT }, paragraph: { spacing: { before: 240, after: 120 }, outlineLevel: 1, keepNext: true, keepLines: true } },
      { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 22, bold: true, color: DARK, font: FONT }, paragraph: { spacing: { before: 200, after: 80 }, outlineLevel: 2, keepNext: true, keepLines: true } },
    ],
  },
  numbering: {
    config: [
      { reference: "bullets", levels: [
        { level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 270 } } } },
        { level: 1, format: LevelFormat.BULLET, text: "◦", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 1080, hanging: 270 } } } },
      ] },
      { reference: "steps", levels: [
        { level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 360 } } } },
      ] },
    ],
  },
  sections: buildSections(),
});

function buildSections() {
  const footer = () => ({ default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [
    new TextRun({ text: "UNO Rulebook RAG Chatbot · Technical report v2.0    ", size: 16, color: INK2 }),
    new TextRun({ children: ["Page ", PageNumber.CURRENT, " of ", PageNumber.TOTAL_PAGES], size: 16, color: INK2 }),
  ] })] }) });
  const margin = { top: 1300, bottom: 1300, left: 1440, right: 1440 };
  const portrait = (items) => ({ properties: { page: { size: { width: 11906, height: 16838 }, margin } }, footers: footer(), children: items });
  const wide = (items) => ({ properties: { page: { size: { width: 11906, height: 16838, orientation: PageOrientation.LANDSCAPE }, margin: { top: 1000, bottom: 1000, left: 1440, right: 1440 } } }, footers: footer(), children: items });
  const out = [];
  let current = [];
  for (const item of children) {
    if (item && item.landscape) {
      if (current.length) out.push(portrait(current));
      out.push(wide(item.landscape));
      current = [];
    } else {
      current.push(item);
    }
  }
  if (current.length) out.push(portrait(current));
  return out;
}

Packer.toBuffer(doc).then((buf) => {
  fs.writeFileSync(OUT, buf);
  console.log(`wrote ${path.relative(ROOT, OUT)} (${Math.round(buf.length / 1024)} KB, ${figNo} figures)`);
});
