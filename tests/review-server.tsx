/** @jsxRuntime automatic */
/** @jsxImportSource kerfjs */

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
import { raw } from "kerfjs";
import * as esbuild from "esbuild";

// ── Paths ──

// Anchor against this file's location so paths resolve correctly regardless
// of cwd (running from the repo root or from inside tests/).
const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = resolve(TESTS_DIR, "output");
const HTML_TEST_DIR = resolve(OUTPUT_DIR, "html-test");
const REAL_WORLD_DIR = resolve(OUTPUT_DIR, "real-world");
const PROJECT_ROOT = resolve(TESTS_DIR, "..");
const SETTINGS_PATH = resolve(PROJECT_ROOT, ".hotsheet/settings.json");

const MANIFEST_FILES: Array<{ suite: SuiteName; path: string; imagesDir: string; isBareArray: boolean }> = [
  { suite: "features",   path: resolve(OUTPUT_DIR,     "features-results.json"), imagesDir: OUTPUT_DIR,     isBareArray: false },
  { suite: "showcase",   path: resolve(OUTPUT_DIR,     "showcase-results.json"), imagesDir: OUTPUT_DIR,     isBareArray: false },
  { suite: "html-test",  path: resolve(HTML_TEST_DIR,  "results.json"),          imagesDir: HTML_TEST_DIR,  isBareArray: true  },
  { suite: "real-world", path: resolve(REAL_WORLD_DIR, "results.json"),          imagesDir: REAL_WORLD_DIR, isBareArray: false },
];

type SuiteName = "features" | "showcase" | "html-test" | "real-world";

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
  // real-world scroll-mode per-chunk metrics (undefined for non-scroll tests).
  // Each chunk has matching `<name>-{expected,actual,diff}-N.png` files
  // (chunk 0 is the canonical no-suffix triplet).
  chunks?: Array<{
    index: number;
    scrollY: number;
    segmentEndMs: number;
    diffPct: number;
    sigPixelPct: number;
    worstTilePct: number;
    worstTileSignificantPct: number;
  }>;
}

interface ReviewManifest {
  generatedAt: string;   // most recent across all suites
  suites: Record<SuiteName, { present: boolean; generatedAt?: string; count: number }>;
  tests: ReviewTest[];
}

function loadManifest(): ReviewManifest {
  const tests: ReviewTest[] = [];
  const suites: ReviewManifest["suites"] = {
    features:    { present: false, count: 0 },
    showcase:    { present: false, count: 0 },
    "html-test": { present: false, count: 0 },
    "real-world":{ present: false, count: 0 },
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
      const rawChunks = r["chunks"];
      let chunks: ReviewTest["chunks"];
      if (Array.isArray(rawChunks)) {
        chunks = [];
        for (const c of rawChunks as Array<Record<string, unknown>>) {
          if (typeof c["index"] !== "number") continue;
          chunks.push({
            index: c["index"],
            scrollY: typeof c["scrollY"] === "number" ? c["scrollY"] : 0,
            segmentEndMs: typeof c["segmentEndMs"] === "number" ? c["segmentEndMs"] : 0,
            diffPct: typeof c["diffPct"] === "number" ? c["diffPct"] : 0,
            sigPixelPct: typeof c["sigPixelPct"] === "number" ? c["sigPixelPct"] : 0,
            worstTilePct: typeof c["worstTilePct"] === "number" ? c["worstTilePct"] : 0,
            worstTileSignificantPct: typeof c["worstTileSignificantPct"] === "number" ? c["worstTileSignificantPct"] : 0,
          });
        }
      }
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
        chunks: chunks != null && chunks.length > 0 ? chunks : undefined,
      });
    }
  }

  const newest = timestamps.sort().pop() ?? new Date().toISOString();
  return { generatedAt: newest, suites, tests };
}

function imagePathFor(t: ReviewTest, kind: "expected" | "actual" | "diff"): string {
  const dir = t.suite === "html-test"  ? HTML_TEST_DIR
            : t.suite === "real-world" ? REAL_WORLD_DIR
            :                            OUTPUT_DIR;
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
  .region-stage { position: relative; }
  .region-overlay { position: absolute; inset: 0; width: 100%; height: 100%; cursor: crosshair; touch-action: none; }
  .region-rect { fill: rgba(255,170,0,0.15); stroke: #ffaa00; stroke-width: 2; vector-effect: non-scaling-stroke; }
  .region-label-bg { fill: rgba(13,17,23,0.85); }
  .region-label-text { fill: #ffaa00; font-family: ui-monospace, monospace; font-size: 14px; font-weight: 700; dominant-baseline: alphabetic; }
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
  .svg-link { font-size: 11px; color: #58a6ff; text-decoration: none; margin-left: auto; }
  .svg-link:hover { text-decoration: underline; }
  .chunk-strip { margin-top: 10px; display: flex; flex-direction: column; gap: 8px; }
  .chunk { background: #0d1117; border: 1px solid #30363d; border-radius: 4px; padding: 8px; }
  .chunk-head { font-size: 11px; color: #8b949e; font-family: ui-monospace, monospace; margin-bottom: 4px; }
  .chunk-imgs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; }
  .chunk-imgs figure { margin: 0; background: #0d1117; border: 1px solid #30363d; border-radius: 3px; overflow: hidden; cursor: zoom-in; }
  .chunk-imgs img { display: block; width: 100%; height: auto; }
`;

// Bundle the kerfjs client (`tests/review-client.tsx`) once at server start
// and serve it at /client.js. The manifest is shipped separately as a JSON
// `<script>` block so manifest changes don't require rebundling.
async function bundleClient(): Promise<string> {
  const result = await esbuild.build({
    entryPoints: [resolve(TESTS_DIR, "review-client.tsx")],
    bundle: true,
    format: "esm",
    target: "es2022",
    write: false,
    sourcemap: "inline",
    jsx: "automatic",
    jsxImportSource: "kerfjs",
    logLevel: "warning",
  });
  if (result.outputFiles.length === 0) throw new Error("esbuild produced no output");
  return result.outputFiles[0].text;
}

// Inline JSON inside a `<script>` is unsafe if the payload contains the
// substring `</script` — escape `<` to `\u003c` so the parser can't be
// tricked into closing the tag early. (No user-controlled strings reach the
// manifest today, but the cost is trivial.)
function safeJsonForScript(payload: unknown): string {
  return JSON.stringify(payload).replace(/</g, "\\u003c");
}

function Layout({ manifestJson }: { manifestJson: string }) {
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
              <option value="real-world">real-world</option>
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
        <script type="application/json" id="manifest-data">{raw(manifestJson)}</script>
        <script type="module" src="/client.js"></script>
      </body>
    </html>
  );
}

function renderReviewPage(manifest: ReviewManifest): string {
  const manifestJson = safeJsonForScript(manifest);
  return `<!DOCTYPE html>\n${(<Layout manifestJson={manifestJson} />).toString()}`;
}

// ── Regions (DM-572 / DM-573) ──

interface ServerRect { index: number; image?: string; x: number; y: number; w: number; h: number; caption?: string }

function sanitizeRegions(raw: unknown): ServerRect[] {
  if (!Array.isArray(raw)) return [];
  const out: ServerRect[] = [];
  let positional = 0;
  for (const item of raw) {
    if (typeof item !== "object" || item == null) continue;
    const r = item as Record<string, unknown>;
    const x = Number(r["x"]);
    const y = Number(r["y"]);
    const w = Number(r["w"]);
    const h = Number(r["h"]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) continue;
    if (w <= 0 || h <= 0 || x < 0 || y < 0) continue;
    positional += 1;
    const idx = Number(r["index"]);
    const region: ServerRect = {
      index: Number.isFinite(idx) && idx > 0 ? Math.floor(idx) : positional,
      x: Math.floor(x),
      y: Math.floor(y),
      w: Math.floor(w),
      h: Math.floor(h),
    };
    const image = typeof r["image"] === "string" ? r["image"].trim() : "";
    if (image !== "") region.image = image;
    const caption = typeof r["caption"] === "string" ? r["caption"].trim() : "";
    if (caption !== "") region.caption = caption;
    out.push(region);
  }
  return out.sort((a, b) => a.index - b.index);
}

function serializeRegions(rects: ServerRect[]): string {
  if (rects.length === 0) return "";
  const lines = ["REGIONS:"];
  for (const r of rects) {
    const pin = r.image != null ? `image=${r.image} ` : "";
    const coords = `(x=${r.x} y=${r.y} w=${r.w} h=${r.h})`;
    const caption = r.caption != null ? ` — ${r.caption}` : "";
    lines.push(`- [${r.index}] ${pin}${coords}${caption}`);
  }
  return lines.join("\n");
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
  const clientJs = await bundleClient();
  if (manifest.tests.length === 0) {
    // eslint-disable-next-line no-console
    console.error("No test results found. Run a suite first:");
    // eslint-disable-next-line no-console
    console.error("  npm run demos:test            # features only");
    // eslint-disable-next-line no-console
    console.error("  npm run demos:test:showcase   # showcase");
    // eslint-disable-next-line no-console
    console.error("  npm run demos:test:html       # html-test (~147)");
    // eslint-disable-next-line no-console
    console.error("  npm run demos:test:real-world # real public sites (DM-454)");
    // eslint-disable-next-line no-console
    console.error("  npm run demos:test:all        # all four");
    process.exit(1);
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://localhost:${port}`);

      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        send(res, 200, "text/html; charset=utf-8", renderReviewPage(manifest));
        return;
      }

      if (req.method === "GET" && url.pathname === "/client.js") {
        send(res, 200, "application/javascript; charset=utf-8", clientJs);
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
        const baseDir = suite === "html-test"  ? HTML_TEST_DIR
                      : suite === "real-world" ? REAL_WORLD_DIR
                      :                          OUTPUT_DIR;
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
        const parsed = JSON.parse(body) as { suite?: string; name?: string; comment?: string; regions?: unknown };
        const suite = parsed.suite as SuiteName | undefined;
        const name = parsed.name ?? "";
        const comment = parsed.comment ?? "";
        const regions = sanitizeRegions(parsed.regions);
        const match = manifest.tests.find((r) => r.name === name && r.suite === suite);
        if (match == null) {
          sendJson(res, 400, { error: `Unknown test: ${suite}/${name}` });
          return;
        }
        const title = `SVG demo test [${match.suite}]: ${name} (${match.diffPct.toFixed(2)}% diff)`;
        const regionsBlock = serializeRegions(regions);
        const detailsParts = [
          `Suite: \`${match.suite}\``,
          `Test: \`${name}\``,
          `Diff: ${match.diffPct.toFixed(2)}% avg${match.sigPixelPct != null ? ` · sig ${match.sigPixelPct.toFixed(1)}%` : ""}${match.worstTilePct != null ? ` · tile avg ${match.worstTilePct.toFixed(1)}%` : ""}${match.worstTileSignificantPct != null ? ` · tile sig ${match.worstTileSignificantPct.toFixed(1)}%` : ""}`,
          `Status: ${match.skipped ? `SKIP (${match.skipReason ?? "no reason"})` : match.error != null ? `ERROR (${match.error})` : match.pass ? "PASS" : "FAIL"}`,
          `Recorded: ${new Date(manifest.generatedAt).toLocaleString()}`,
          "",
          comment !== "" ? comment : "_(no comment provided)_",
        ];
        if (regionsBlock !== "") {
          detailsParts.push("", regionsBlock);
        }
        if (!match.skipped) {
          const relPath = match.suite === "html-test"  ? "tests/output/html-test"
                        : match.suite === "real-world" ? "tests/output/real-world"
                        :                                "tests/output";
          detailsParts.push(
            "",
            "Source files:",
          );
          // Real-world tests don't have a local .html input — the source
          // is a remote URL, captured live each run. Other suites do.
          if (match.suite !== "real-world") {
            detailsParts.push(`- ${relPath}/${name}.html (input)`);
          }
          detailsParts.push(`- ${relPath}/${name}.svg (generated)`);
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
