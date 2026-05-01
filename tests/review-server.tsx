/** @jsxRuntime automatic */
/** @jsxImportSource #jsx */

/**
 * SVG Demo Test Review Tool (SK-728)
 *
 * Spins up a tiny local HTTP server that renders a review page for the
 * pixel-regression test suites. Covers:
 *   - features    (tests/features.ts)        ~39 tests
 *   - showcase    (tests/showcase.ts)         ~3 tests
 *   - html-test   (tests/html-test-suite.tsx) ~147 tests
 *
 * For each test you see expected / actual / diff PNGs side-by-side, can write
 * a freeform comment, and with one click file a Hot Sheet ticket (with the
 * three images attached).
 *
 * The server is a browser → Hot Sheet proxy so the page is same-origin (no
 * CORS on POST) and the Hot Sheet secret never leaves the node process.
 *
 * Usage:
 *   # After running any or all of the test suites:
 *   npm run demos:test:all   # runs all three
 *   npm run demos:review     # opens the review page
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { resolve, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { raw } from "../src/jsx-runtime.js";

// ── Paths ──

// Anchor against this file's location so paths resolve correctly regardless
// of cwd (running from the repo root or from inside tests/).
const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = resolve(TESTS_DIR, "output");
const HTML_TEST_DIR = resolve(OUTPUT_DIR, "html-test");
const PROJECT_ROOT = resolve(TESTS_DIR, "..");
const SETTINGS_PATH = resolve(PROJECT_ROOT, ".hotsheet/settings.json");

const MANIFEST_FILES: Array<{ suite: SuiteName; path: string; imagesDir: string; isBareArray: boolean }> = [
  { suite: "features",  path: resolve(OUTPUT_DIR, "features-results.json"),  imagesDir: OUTPUT_DIR,    isBareArray: false },
  { suite: "showcase",  path: resolve(OUTPUT_DIR, "showcase-results.json"),  imagesDir: OUTPUT_DIR,    isBareArray: false },
  { suite: "html-test", path: resolve(HTML_TEST_DIR, "results.json"),        imagesDir: HTML_TEST_DIR, isBareArray: true  },
];

type SuiteName = "features" | "showcase" | "html-test";

// ── Config ──

interface Settings { port: number; secret: string }
function loadSettings(): Settings {
  if (!existsSync(SETTINGS_PATH)) {
    throw new Error(`Hot Sheet settings not found at ${SETTINGS_PATH} — is Hot Sheet set up?`);
  }
  const raw = JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as { port?: number; secret?: string };
  if (raw.port == null || raw.secret == null) throw new Error(`Hot Sheet settings missing port or secret`);
  return { port: raw.port, secret: raw.secret };
}

// Normalized test record used by the UI and ticket filer.
interface ReviewTest {
  suite: SuiteName;
  name: string;
  diffPct: number;
  pass: boolean;
  skipped: boolean;
  skipReason?: string;
  error?: string;
  // html-test extras (undefined for features/showcase)
  sigPixelPct?: number;
  worstTilePct?: number;
  worstTileSignificantPct?: number;
  warningCount?: number;
  category?: string;
}

interface ReviewManifest {
  generatedAt: string;   // most recent across all suites
  suites: Record<SuiteName, { present: boolean; generatedAt?: string; count: number }>;
  tests: ReviewTest[];
}

function loadManifest(): ReviewManifest {
  const tests: ReviewTest[] = [];
  const suites: ReviewManifest["suites"] = {
    features:  { present: false, count: 0 },
    showcase:  { present: false, count: 0 },
    "html-test": { present: false, count: 0 },
  };
  const timestamps: string[] = [];

  for (const m of MANIFEST_FILES) {
    if (!existsSync(m.path)) continue;
    suites[m.suite].present = true;
    const raw = JSON.parse(readFileSync(m.path, "utf8")) as unknown;

    let generatedAt: string | undefined;
    let records: unknown[];
    if (m.isBareArray) {
      records = Array.isArray(raw) ? raw : [];
    } else {
      const wrapped = raw as { generatedAt?: string; results?: unknown[] };
      generatedAt = wrapped.generatedAt;
      records = wrapped.results ?? [];
    }
    if (generatedAt != null) {
      suites[m.suite].generatedAt = generatedAt;
      timestamps.push(generatedAt);
    }
    suites[m.suite].count = records.length;

    for (const r of records as Array<Record<string, unknown>>) {
      const name = String(r["name"] ?? "");
      if (name === "") continue;
      tests.push({
        suite: m.suite,
        name,
        diffPct: typeof r["diffPct"] === "number" ? r["diffPct"] : 0,
        pass: Boolean(r["pass"]),
        skipped: Boolean(r["skipped"]),
        skipReason: typeof r["skipReason"] === "string" ? r["skipReason"] : undefined,
        error: typeof r["error"] === "string" ? r["error"] : undefined,
        sigPixelPct: typeof r["sigPixelPct"] === "number" ? r["sigPixelPct"] : undefined,
        worstTilePct: typeof r["worstTilePct"] === "number" ? r["worstTilePct"] : undefined,
        worstTileSignificantPct: typeof r["worstTileSignificantPct"] === "number" ? r["worstTileSignificantPct"] : undefined,
        warningCount: Array.isArray(r["warnings"]) ? r["warnings"].length : undefined,
        category: typeof r["category"] === "string" ? r["category"] : undefined,
      });
    }
  }

  const newest = timestamps.sort().pop() ?? new Date().toISOString();
  return { generatedAt: newest, suites, tests };
}

function imagePathFor(t: ReviewTest, kind: "expected" | "actual" | "diff"): string {
  const dir = t.suite === "html-test" ? HTML_TEST_DIR : OUTPUT_DIR;
  return resolve(dir, `${t.name}-${kind}.png`);
}

// ── HTTP helpers ──

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, contentType: string, body: string | Buffer): void {
  res.statusCode = status;
  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "no-store");
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  send(res, status, "application/json", JSON.stringify(obj));
}

// ── Hot Sheet proxy ──

async function createHotSheetTicket(
  settings: Settings,
  title: string,
  details: string,
): Promise<{ id: number; ticket_number: string }> {
  const resp = await fetch(`http://localhost:${settings.port}/api/tickets`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Hotsheet-Secret": settings.secret },
    body: JSON.stringify({ title, defaults: { category: "bug", up_next: false, details } }),
  });
  if (!resp.ok) throw new Error(`Hot Sheet ticket create failed: ${resp.status} ${resp.statusText}`);
  return await resp.json() as { id: number; ticket_number: string };
}

async function attachFileToTicket(settings: Settings, ticketId: number, filePath: string): Promise<void> {
  const fileName = filePath.split("/").pop() ?? "attachment.png";
  const buf = readFileSync(filePath);
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(buf)], { type: "image/png" }), fileName);
  const resp = await fetch(`http://localhost:${settings.port}/api/tickets/${ticketId}/attachments`, {
    method: "POST",
    headers: { "X-Hotsheet-Secret": settings.secret },
    body: form,
  });
  if (!resp.ok) throw new Error(`Attach ${fileName} failed: ${resp.status} ${resp.statusText}`);
}

// ── Review page ──

const REVIEW_CSS = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0d1117; color: #e6edf3; }
  header { position: sticky; top: 0; z-index: 10; background: #161b22; border-bottom: 1px solid #30363d; padding: 14px 24px; }
  header h1 { margin: 0 0 8px; font-size: 18px; }
  .controls { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; }
  .controls label { font-size: 13px; color: #8b949e; }
  .controls select { background: #0d1117; color: #e6edf3; border: 1px solid #30363d; padding: 4px 8px; border-radius: 4px; }
  .stats { margin-left: auto; font-size: 13px; color: #8b949e; text-align: right; }
  main { padding: 20px 24px; display: grid; grid-template-columns: repeat(auto-fill, minmax(620px, 1fr)); gap: 16px; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 14px; }
  .card.pass { opacity: 0.7; }
  .card.skipped { opacity: 0.5; }
  .head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 10px; flex-wrap: wrap; }
  .head strong { font-size: 15px; font-family: ui-monospace, monospace; }
  .badge { font-size: 11px; padding: 2px 8px; border-radius: 10px; font-weight: 600; letter-spacing: 0.3px; }
  .badge.fail { background: #5a1d1d; color: #ffa198; }
  .badge.pass { background: #1d4a28; color: #56d364; }
  .badge.skip { background: #3b2f07; color: #d4a82b; }
  .badge.err { background: #5a1d1d; color: #ffa198; }
  .badge.suite { background: #223158; color: #79b8ff; }
  .metrics { font-size: 11px; color: #8b949e; }
  .imgs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin-bottom: 10px; }
  .imgs figure { margin: 0; background: #0d1117; border: 1px solid #30363d; border-radius: 4px; overflow: hidden; cursor: zoom-in; }
  .imgs figcaption { font-size: 11px; color: #8b949e; padding: 4px 6px; border-bottom: 1px solid #30363d; text-align: center; letter-spacing: 0.3px; }
  .imgs img { display: block; width: 100%; height: auto; }
  .skip-note { font-size: 12px; color: #8b949e; font-style: italic; padding: 10px 0; }
  .comment { width: 100%; background: #0d1117; color: #e6edf3; border: 1px solid #30363d; border-radius: 4px; padding: 8px; font: inherit; resize: vertical; min-height: 54px; }
  .actions { display: flex; gap: 10px; margin-top: 8px; align-items: center; }
  .file-btn { background: #238636; color: #fff; border: none; padding: 7px 14px; border-radius: 5px; font-weight: 600; cursor: pointer; font-size: 13px; }
  .file-btn:hover { background: #2ea043; }
  .file-btn:disabled { background: #3a3a3a; cursor: wait; }
  .status-msg { font-size: 12px; color: #8b949e; }
  .status-msg.ok { color: #56d364; }
  .status-msg.err { color: #ffa198; }
  .lightbox { position: fixed; inset: 0; background: rgba(0,0,0,0.85); display: none; align-items: center; justify-content: center; z-index: 100; cursor: zoom-out; }
  .lightbox.open { display: flex; }
  .lightbox img { max-width: 96vw; max-height: 96vh; }
  .suite-summary { font-size: 12px; color: #8b949e; margin-top: 4px; }
`;

const REVIEW_SCRIPT_TEMPLATE = (payload: string) => `
const MANIFEST = ${payload};
const filterEl = document.getElementById("filter");
const suiteEl = document.getElementById("suite");
const sortEl = document.getElementById("sort");
const cards = document.getElementById("cards");
const stats = document.getElementById("stats");
const summary = document.getElementById("suite-summary");
const lb = document.getElementById("lightbox");
const lbImg = document.getElementById("lb-img");

// Track the currently-focused lightbox figure so arrow keys can step to the
// previous/next image (in DOM order across all visible cards). Populated
// when a figure is clicked; cleared when the lightbox closes.
let lbFigures = [];
let lbIndex = -1;

function closeLightbox() {
  lb.classList.remove("open");
  lbFigures = [];
  lbIndex = -1;
}

function showLightboxAt(idx) {
  if (idx < 0 || idx >= lbFigures.length) return;
  lbIndex = idx;
  lbImg.src = lbFigures[idx].dataset.src;
  lb.classList.add("open");
  // Scroll the underlying page so the figure's card is centered in the
  // viewport — invisible while the lightbox is over the page, but means
  // closing the lightbox lands you on the test you were just inspecting
  // instead of wherever you opened the lightbox from. (DM-412)
  const card = lbFigures[idx].closest(".card");
  if (card != null) card.scrollIntoView({ block: "center", behavior: "auto" });
}

lb.addEventListener("click", closeLightbox);

document.addEventListener("keydown", (e) => {
  if (!lb.classList.contains("open")) return;
  if (e.key === "ArrowRight" || e.key === "ArrowDown") {
    e.preventDefault();
    const next = lbIndex + 1 < lbFigures.length ? lbIndex + 1 : 0;
    showLightboxAt(next);
  } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
    e.preventDefault();
    const prev = lbIndex - 1 >= 0 ? lbIndex - 1 : lbFigures.length - 1;
    showLightboxAt(prev);
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeLightbox();
  }
});

function img(url) { return \`<img src="\${url}" loading="lazy" alt=""/>\`; }

function extraMetrics(r) {
  if (r.sigPixelPct == null) return "";
  const parts = [
    \`sig \${r.sigPixelPct.toFixed(1)}%\`,
    r.worstTilePct != null ? \`tile avg \${r.worstTilePct.toFixed(1)}%\` : null,
    r.worstTileSignificantPct != null ? \`tile sig \${r.worstTileSignificantPct.toFixed(1)}%\` : null,
    r.warningCount ? \`\${r.warningCount} warn\` : null,
  ].filter(Boolean).join(" · ");
  return \`<span class="metrics">\${parts}</span>\`;
}

function cardHtml(r) {
  let badge, statusClass;
  if (r.skipped)       { badge = 'SKIP'; statusClass = 'skip'; }
  else if (r.error)    { badge = 'ERROR'; statusClass = 'err'; }
  else if (r.pass)     { badge = 'PASS'; statusClass = 'pass'; }
  else                 { badge = 'FAIL'; statusClass = 'fail'; }
  const cardCls = r.skipped ? 'skipped' : (r.pass ? 'pass' : '');
  const imagesHtml = r.skipped
    ? \`<div class="skip-note">Skipped: \${r.skipReason ?? '(no reason given)'}</div>\`
    : \`<div class="imgs">
         <figure data-src="/img/\${r.suite}/\${r.name}-expected.png"><figcaption>expected</figcaption>\${img(\`/img/\${r.suite}/\${r.name}-expected.png\`)}</figure>
         <figure data-src="/img/\${r.suite}/\${r.name}-actual.png"><figcaption>actual</figcaption>\${img(\`/img/\${r.suite}/\${r.name}-actual.png\`)}</figure>
         <figure data-src="/img/\${r.suite}/\${r.name}-diff.png"><figcaption>diff</figcaption>\${img(\`/img/\${r.suite}/\${r.name}-diff.png\`)}</figure>
       </div>\`;
  return \`<section class="card \${cardCls}" data-name="\${r.name}" data-suite="\${r.suite}">
    <div class="head">
      <strong>\${r.name}</strong>
      <span class="badge suite">\${r.suite}</span>
      <span class="badge \${statusClass}">\${badge} · \${r.diffPct.toFixed(2)}%</span>
      \${extraMetrics(r)}
    </div>
    \${imagesHtml}
    <textarea class="comment" placeholder="What's wrong or worth a ticket? (Ticket will include the three images, metrics, and your comment.)"></textarea>
    <div class="actions">
      <button class="file-btn">File ticket</button>
      <span class="status-msg"></span>
    </div>
  </section>\`;
}

function render() {
  const filter = filterEl.value;
  const suite = suiteEl.value;
  const sort = sortEl.value;
  let list = [...MANIFEST.tests];
  if (filter === "fail") list = list.filter((r) => !r.pass && !r.skipped);
  else if (filter === "pass") list = list.filter((r) => r.pass);
  if (suite !== "all") list = list.filter((r) => r.suite === suite);
  if (sort === "diff-desc") list.sort((a, b) => b.diffPct - a.diffPct);
  else if (sort === "diff-asc") list.sort((a, b) => a.diffPct - b.diffPct);
  else if (sort === "name") list.sort((a, b) => a.name.localeCompare(b.name));
  cards.innerHTML = list.map(cardHtml).join("");
  const total = MANIFEST.tests.length;
  const failing = MANIFEST.tests.filter((r) => !r.pass && !r.skipped).length;
  const skipped = MANIFEST.tests.filter((r) => r.skipped).length;
  stats.textContent = \`\${list.length} shown · \${failing}/\${total} failing\${skipped ? \` · \${skipped} skipped\` : ''}\`;
}

function renderSummary() {
  const parts = Object.entries(MANIFEST.suites).map(([name, info]) => {
    if (!info.present) return \`<span style="color:#5a5a5a">\${name}: (not run)</span>\`;
    const when = info.generatedAt ? new Date(info.generatedAt).toLocaleString() : "(no timestamp)";
    return \`<span><strong>\${name}</strong>: \${info.count} tests · \${when}</span>\`;
  }).join(" · ");
  summary.innerHTML = parts;
}

filterEl.addEventListener("change", render);
suiteEl.addEventListener("change", render);
sortEl.addEventListener("change", render);

cards.addEventListener("click", (e) => {
  const fig = e.target.closest("figure[data-src]");
  if (fig != null) {
    // Snapshot every visible figure in DOM order so arrow keys walk the
    // whole currently-filtered set (not just the clicked card's three).
    lbFigures = Array.from(cards.querySelectorAll("figure[data-src]"));
    lbIndex = lbFigures.indexOf(fig);
    showLightboxAt(lbIndex);
    return;
  }
  const btn = e.target.closest(".file-btn");
  if (btn != null) void fileTicket(btn);
});

async function fileTicket(btn) {
  const card = btn.closest(".card");
  const name = card.dataset.name;
  const suite = card.dataset.suite;
  const comment = card.querySelector(".comment").value.trim();
  const msg = card.querySelector(".status-msg");
  msg.className = "status-msg";
  msg.textContent = "";
  btn.disabled = true;
  btn.textContent = "Filing...";
  try {
    const res = await fetch("/api/file-ticket", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ suite, name, comment }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || \`HTTP \${res.status}\`);
    msg.className = "status-msg ok";
    msg.textContent = \`Filed \${json.ticket_number}\`;
    card.querySelector(".comment").value = "";
  } catch (err) {
    msg.className = "status-msg err";
    msg.textContent = "Failed: " + (err instanceof Error ? err.message : String(err));
  } finally {
    btn.disabled = false;
    btn.textContent = "File ticket";
  }
}

renderSummary();
render();
`;

function Layout({ payload }: { payload: string }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>SVG Demo Test Review</title>
        <style>{raw(REVIEW_CSS)}</style>
      </head>
      <body>
        <header>
          <h1>SVG Demo Test Review</h1>
          <div className="controls">
            <label>Filter: <select id="filter">
              <option value="fail">Failing</option>
              <option value="all">All</option>
              <option value="pass">Passing</option>
            </select></label>
            <label>Suite: <select id="suite">
              <option value="all">All suites</option>
              <option value="features">features</option>
              <option value="showcase">showcase</option>
              <option value="html-test">html-test</option>
            </select></label>
            <label>Sort: <select id="sort">
              <option value="diff-desc">Diff % (worst first)</option>
              <option value="diff-asc">Diff % (best first)</option>
              <option value="name">Name (A→Z)</option>
            </select></label>
            <span className="stats" id="stats"></span>
          </div>
          <div className="suite-summary" id="suite-summary"></div>
        </header>
        <main id="cards"></main>
        <div className="lightbox" id="lightbox"><img id="lb-img" alt="" /></div>
        <script>{raw(REVIEW_SCRIPT_TEMPLATE(payload))}</script>
      </body>
    </html>
  );
}

function renderReviewPage(manifest: ReviewManifest): string {
  const payload = JSON.stringify(manifest);
  return `<!DOCTYPE html>\n${(<Layout payload={payload} />).toString()}`;
}

// ── MIME ──

function mimeFor(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".json") return "application/json";
  return "application/octet-stream";
}

// ── Main ──

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const portIdx = args.indexOf("--port");
  const port = portIdx >= 0 ? parseInt(args[portIdx + 1], 10) : 4175;

  const settings = loadSettings();
  const manifest = loadManifest();
  if (manifest.tests.length === 0) {
    // eslint-disable-next-line no-console
    console.error("No test results found. Run a suite first:");
    // eslint-disable-next-line no-console
    console.error("  npm run demos:test          # features only");
    // eslint-disable-next-line no-console
    console.error("  npm run demos:test:showcase # showcase");
    // eslint-disable-next-line no-console
    console.error("  npm run demos:test:html     # html-test (~147)");
    // eslint-disable-next-line no-console
    console.error("  npm run demos:test:all      # all three");
    process.exit(1);
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://localhost:${port}`);

      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        send(res, 200, "text/html; charset=utf-8", renderReviewPage(manifest));
        return;
      }

      if (req.method === "GET" && url.pathname.startsWith("/img/")) {
        // /img/<suite>/<filename>
        const rest = url.pathname.slice(5);
        const slash = rest.indexOf("/");
        if (slash < 0) { send(res, 400, "text/plain", "bad path"); return; }
        const suite = rest.slice(0, slash);
        const fname = rest.slice(slash + 1);
        if (fname.includes("/") || fname.includes("..")) {
          send(res, 400, "text/plain", "bad path");
          return;
        }
        const baseDir = suite === "html-test" ? HTML_TEST_DIR : OUTPUT_DIR;
        const filePath = resolve(baseDir, fname);
        if (!existsSync(filePath)) {
          send(res, 404, "text/plain", "not found");
          return;
        }
        send(res, 200, mimeFor(fname), readFileSync(filePath));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/file-ticket") {
        const body = await readBody(req);
        const parsed = JSON.parse(body) as { suite?: string; name?: string; comment?: string };
        const suite = parsed.suite as SuiteName | undefined;
        const name = parsed.name ?? "";
        const comment = parsed.comment ?? "";
        const match = manifest.tests.find((r) => r.name === name && r.suite === suite);
        if (match == null) {
          sendJson(res, 400, { error: `Unknown test: ${suite}/${name}` });
          return;
        }
        const title = `SVG demo test [${match.suite}]: ${name} (${match.diffPct.toFixed(2)}% diff)`;
        const detailsParts = [
          `Suite: \`${match.suite}\``,
          `Test: \`${name}\``,
          `Diff: ${match.diffPct.toFixed(2)}% avg${match.sigPixelPct != null ? ` · sig ${match.sigPixelPct.toFixed(1)}%` : ""}${match.worstTilePct != null ? ` · tile avg ${match.worstTilePct.toFixed(1)}%` : ""}${match.worstTileSignificantPct != null ? ` · tile sig ${match.worstTileSignificantPct.toFixed(1)}%` : ""}`,
          `Status: ${match.skipped ? `SKIP (${match.skipReason ?? "no reason"})` : match.error != null ? `ERROR (${match.error})` : match.pass ? "PASS" : "FAIL"}`,
          `Recorded: ${new Date(manifest.generatedAt).toLocaleString()}`,
          "",
          comment !== "" ? comment : "_(no comment provided)_",
        ];
        if (!match.skipped) {
          const relPath = match.suite === "html-test" ? "tests/output/html-test" : "tests/output";
          detailsParts.push(
            "",
            "Source files:",
            `- ${relPath}/${name}.html (input)`,
            `- ${relPath}/${name}.svg (generated)`,
          );
        }
        const details = detailsParts.join("\n");

        const ticket = await createHotSheetTicket(settings, title, details);
        const attachments: string[] = [];
        const failed: string[] = [];
        if (!match.skipped) {
          for (const kind of ["expected", "actual", "diff"] as const) {
            const p = imagePathFor(match, kind);
            if (!existsSync(p)) continue;
            try {
              await attachFileToTicket(settings, ticket.id, p);
              attachments.push(`${name}-${kind}.png`);
            } catch (e) {
              failed.push(`${kind}: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
        }
        sendJson(res, 200, {
          ticket_number: ticket.ticket_number,
          id: ticket.id,
          attached: attachments,
          attach_errors: failed,
        });
        return;
      }

      send(res, 404, "text/plain", "not found");
    } catch (e) {
      sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  });

  server.listen(port, () => {
    const url = `http://localhost:${port}/`;
    const failing = manifest.tests.filter((r) => !r.pass && !r.skipped).length;
    const skipped = manifest.tests.filter((r) => r.skipped).length;
    // eslint-disable-next-line no-console
    console.log(`\nSVG Demo Test Review — ${failing} failing · ${skipped} skipped · ${manifest.tests.length} total`);
    for (const [suite, info] of Object.entries(manifest.suites)) {
      // eslint-disable-next-line no-console
      console.log(`  ${suite.padEnd(10)} ${info.present ? `${info.count} tests` : "(not run)"}`);
    }
    // eslint-disable-next-line no-console
    console.log(`  ${url}`);
    // eslint-disable-next-line no-console
    console.log(`  (Ctrl+C to stop)`);
    try { spawn("open", [url], { stdio: "ignore", detached: true }).unref(); } catch { /* manual open works */ }
  });
}

void main();
