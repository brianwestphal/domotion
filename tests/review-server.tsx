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
 *
 * DM-1660: the page toggles between FOUR result sources via the header "Source"
 * selector — the local macOS run (the plain tests/output/ the suites write to)
 * plus the three CI platforms downloaded into tests/output/review/ci-<os>/ by
 * tools/run-ci-visual-tests.mjs. Switching the selector reloads with ?source=<id>
 * and the server re-renders + serves images from that source's folder, so you can
 * compare the same fixture across local / CI-macOS / CI-Linux / CI-Windows.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, mkdtempSync, readdirSync, rmSync, copyFileSync } from "node:fs";
import { resolve, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { raw } from "kerfjs";
import * as esbuild from "esbuild";

// ── Paths ──

// Anchor against this file's location so paths resolve correctly regardless
// of cwd (running from the repo root or from inside tests/).
const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT_DIR = resolve(TESTS_DIR, "output");
const PROJECT_ROOT = resolve(TESTS_DIR, "..");
const SETTINGS_PATH = resolve(PROJECT_ROOT, ".hotsheet/settings.json");
const SECRET_PATH = resolve(PROJECT_ROOT, ".hotsheet/secret.json");
const WORKLIST_PATH = resolve(PROJECT_ROOT, ".hotsheet/worklist.md");

type SuiteName = "features" | "showcase" | "html-test" | "html-test-unicode" | "real-world";

// DM-1660: the review UI toggles between FOUR result sources — the local macOS
// run plus the three CI platforms (downloaded per-platform by
// tools/run-ci-visual-tests.mjs into separate folders). Each source is a
// self-contained OUTPUT_DIR-style root holding the same suite layout
// (features-results.json, showcase-results.json, html-test/, html-test-unicode/,
// real-world/). `local-macos` maps to the plain `tests/output/` the local suites
// write to (overridable via REVIEW_OUTPUT_DIR, kept for back-compat / DM-1216);
// the CI sources live under `tests/output/review/ci-<os>/`.
interface Source { id: string; label: string; root: string }
const REVIEW_BASE = resolve(DEFAULT_OUTPUT_DIR, "review");
const LOCAL_MACOS_ROOT = process.env.REVIEW_OUTPUT_DIR != null && process.env.REVIEW_OUTPUT_DIR !== ""
  ? resolve(process.env.REVIEW_OUTPUT_DIR)
  : DEFAULT_OUTPUT_DIR;
const SOURCES: Source[] = [
  { id: "local-macos", label: "Local · macOS", root: LOCAL_MACOS_ROOT },
  { id: "ci-macos",    label: "CI · macOS",    root: resolve(REVIEW_BASE, "ci-macos") },
  { id: "ci-linux",    label: "CI · Linux",    root: resolve(REVIEW_BASE, "ci-linux") },
  { id: "ci-windows",  label: "CI · Windows",  root: resolve(REVIEW_BASE, "ci-windows") },
];

// The per-suite manifest files + image dirs under a given source root.
function suiteLayout(root: string): {
  dirs: Record<SuiteName, string>;
  manifests: Array<{ suite: SuiteName; path: string; isBareArray: boolean }>;
} {
  const htmlDir = resolve(root, "html-test");
  const uniDir = resolve(root, "html-test-unicode");
  const rwDir = resolve(root, "real-world");
  return {
    dirs: { features: root, showcase: root, "html-test": htmlDir, "html-test-unicode": uniDir, "real-world": rwDir },
    manifests: [
      { suite: "features",          path: resolve(root,    "features-results.json"), isBareArray: false },
      { suite: "showcase",          path: resolve(root,    "showcase-results.json"), isBareArray: false },
      { suite: "html-test",         path: resolve(htmlDir, "results.json"),          isBareArray: true  },
      { suite: "html-test-unicode", path: resolve(uniDir,  "results.json"),          isBareArray: true  },
      { suite: "real-world",        path: resolve(rwDir,   "results.json"),          isBareArray: false },
    ],
  };
}

function sourceIsPresent(root: string): boolean {
  return suiteLayout(root).manifests.some((m) => existsSync(m.path));
}
function suiteDir(root: string, suite: SuiteName): string {
  return suiteLayout(root).dirs[suite];
}
function sourceById(id: string | null): Source {
  return SOURCES.find((s) => s.id === id) ?? SOURCES[0];
}

// ── Config ──

interface Settings { port: number; secret: string }
// Hot Sheet's API `port` + `secret` enable the optional "file a ticket" button;
// browsing the expected/actual/diff PNGs works without them. Resolve from the
// current Hot Sheet layout — the secret lives in `.hotsheet/secret.json` and the
// API port is embedded in the worklist's curl examples — falling back to the old
// `settings.json` schema. Returns null (browse-only) when neither is available,
// so the review UI still starts.
function loadSettings(): Settings | null {
  let port: number | undefined;
  let secret: string | undefined;
  const readJson = (p: string): Record<string, unknown> => {
    try { return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown> : {}; }
    catch { return {}; }
  };
  // Preferred: secret.json (current) + worklist API port. Then settings.json (legacy).
  secret = readJson(SECRET_PATH).secret as string | undefined;
  const legacy = readJson(SETTINGS_PATH);
  port ??= legacy.port as number | undefined;
  secret ??= legacy.secret as string | undefined;
  if (port == null && existsSync(WORKLIST_PATH)) {
    const m = readFileSync(WORKLIST_PATH, "utf8").match(/localhost:(\d+)\/api/);
    if (m != null) port = parseInt(m[1], 10);
  }
  if (port == null || secret == null) {
    console.warn("⚠ Hot Sheet port/secret not found — the 'file a ticket' button is disabled (browsing diffs still works).");
    return null;
  }
  return { port, secret };
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
  // DM-715 region metrics (undefined on results.json files written before the
  // scoring change). Pass/fail keys off `regionCount === 0`; `diffPct` is no
  // longer the primary signal because a small image-wide percentage can hide
  // a large localized region in a critical area.
  regionCount?: number;
  totalChangedArea?: number;
  maxRegionSeverity?: number;
  scatteredPixels?: number;
  shiftedPixels?: number;
  shiftyRegionCount?: number;
  shiftyRegionArea?: number;
  coveragePct?: number;
  verdict?: string;
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
    regionCount?: number;
    totalChangedArea?: number;
    maxRegionSeverity?: number;
    scatteredPixels?: number;
  }>;
}

interface ReviewManifest {
  generatedAt: string;   // most recent across all suites
  suites: Record<SuiteName, { present: boolean; generatedAt?: string; count: number }>;
  tests: ReviewTest[];
  // DM-1660: which source this manifest was built from, and the full toggle list
  // (present = has ≥1 manifest on disk) so the client can render the selector.
  activeSource: string;
  sources: Array<{ id: string; label: string; present: boolean }>;
}

function loadManifest(activeSourceId: string): ReviewManifest {
  const root = sourceById(activeSourceId).root;
  const manifestFiles = suiteLayout(root).manifests;
  const tests: ReviewTest[] = [];
  const suites: ReviewManifest["suites"] = {
    features:            { present: false, count: 0 },
    showcase:            { present: false, count: 0 },
    "html-test":         { present: false, count: 0 },
    "html-test-unicode": { present: false, count: 0 },
    "real-world":        { present: false, count: 0 },
  };
  const timestamps: string[] = [];

  for (const m of manifestFiles) {
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
            regionCount: typeof c["regionCount"] === "number" ? c["regionCount"] : undefined,
            totalChangedArea: typeof c["totalChangedArea"] === "number" ? c["totalChangedArea"] : undefined,
            maxRegionSeverity: typeof c["maxRegionSeverity"] === "number" ? c["maxRegionSeverity"] : undefined,
            scatteredPixels: typeof c["scatteredPixels"] === "number" ? c["scatteredPixels"] : undefined,
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
        regionCount: typeof r["regionCount"] === "number" ? r["regionCount"] : undefined,
        totalChangedArea: typeof r["totalChangedArea"] === "number" ? r["totalChangedArea"] : undefined,
        maxRegionSeverity: typeof r["maxRegionSeverity"] === "number" ? r["maxRegionSeverity"] : undefined,
        scatteredPixels: typeof r["scatteredPixels"] === "number" ? r["scatteredPixels"] : undefined,
        shiftedPixels: typeof r["shiftedPixels"] === "number" ? r["shiftedPixels"] : undefined,
        shiftyRegionCount: typeof r["shiftyRegionCount"] === "number" ? r["shiftyRegionCount"] : undefined,
        shiftyRegionArea: typeof r["shiftyRegionArea"] === "number" ? r["shiftyRegionArea"] : undefined,
        coveragePct: typeof r["coveragePct"] === "number" ? r["coveragePct"] : undefined,
        verdict: typeof r["verdict"] === "string" ? r["verdict"] : undefined,
        warningCount: Array.isArray(r["warnings"]) ? r["warnings"].length : undefined,
        category: typeof r["category"] === "string" ? r["category"] : undefined,
        chunks: chunks != null && chunks.length > 0 ? chunks : undefined,
      });
    }
  }

  const newest = timestamps.sort().pop() ?? new Date().toISOString();
  const sources = SOURCES.map((s) => ({ id: s.id, label: s.label, present: sourceIsPresent(s.root) }));
  return { generatedAt: newest, suites, tests, activeSource: activeSourceId, sources };
}

function imagePathFor(root: string, t: ReviewTest, kind: "expected" | "actual" | "diff"): string {
  return resolve(suiteDir(root, t.suite), `${t.name}-${kind}.png`);
}

// ── DM-1661: lazy image fetch for CI sources ──
// A CI source is pre-populated with only metadata (results.json — each entry
// carries its `shard`) + a `.ci-source.json` recording the run. The images are
// fetched on demand: when the browser requests one that isn't cached yet, we
// download just the containing shard's artifact and extract its PNGs.

interface CiSourceMeta { runId: string; os: string; suite: string }

function readCiSourceMeta(root: string, suite: SuiteName): CiSourceMeta | null {
  const p = resolve(suiteDir(root, suite), ".ci-source.json");
  if (!existsSync(p)) return null;
  try {
    const m = JSON.parse(readFileSync(p, "utf8")) as Partial<CiSourceMeta>;
    if (typeof m.runId === "string" && typeof m.os === "string") return { runId: m.runId, os: m.os, suite: suite };
  } catch { /* malformed — treat as no lazy source */ }
  return null;
}

function shardForFixture(root: string, suite: SuiteName, fixtureBase: string): number | null {
  const rp = resolve(suiteDir(root, suite), "results.json");
  if (!existsSync(rp)) return null;
  try {
    const arr = JSON.parse(readFileSync(rp, "utf8")) as Array<{ name?: string; shard?: number }>;
    const hit = arr.find((r) => r.name === fixtureBase);
    return typeof hit?.shard === "number" ? hit.shard : null;
  } catch { return null; }
}

// Download one shard's artifact + cache its PNGs into the source dir. In-flight
// locked by (runId, os, shard) so N concurrent image requests for the same shard
// share a single `gh run download`.
const inflightShardFetches = new Map<string, Promise<void>>();
function fetchShard(root: string, suite: SuiteName, meta: CiSourceMeta, shard: number): Promise<void> {
  const key = `${meta.runId}:${meta.os}:${shard}`;
  const existing = inflightShardFetches.get(key);
  if (existing != null) return existing;
  const dest = suiteDir(root, suite);
  const task = (async () => {
    const tmp = mkdtempSync(resolve(tmpdir(), "review-shard-"));
    try {
      console.log(`  ↓ lazy-fetching ${meta.os} shard ${shard} (run ${meta.runId})…`);
      execFileSync("gh", ["run", "download", meta.runId, "--dir", tmp,
        "--pattern", `results-${meta.os}-shard${shard}`], { stdio: "pipe" });
      const walk = (d: string): void => {
        for (const ent of readdirSync(d, { withFileTypes: true })) {
          const full = resolve(d, ent.name);
          if (ent.isDirectory()) walk(full);
          else if (ent.name.endsWith(".png")) copyFileSync(full, resolve(dest, ent.name));
        }
      };
      walk(tmp);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
      inflightShardFetches.delete(key);
    }
  })();
  inflightShardFetches.set(key, task);
  return task;
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
  .controls label.toggle { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; user-select: none; }
  .controls label.toggle input { margin: 0; cursor: pointer; }
  body.hide-live-svg .live-svg { display: none; }
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
  .lightbox { position: fixed; inset: 0; background: rgba(0,0,0,0.85); display: none; z-index: 100; cursor: zoom-out; }
  .lightbox.open { display: flex; align-items: center; justify-content: center; }
  /* Fit-to-screen for landscape / square images (the default). */
  .lightbox .region-stage { position: relative; display: inline-block; max-width: 96vw; max-height: 96vh; }
  .lightbox .region-stage img { display: block; max-width: 96vw; max-height: 96vh; width: auto; height: auto; }
  /* Tall mode (DM-736): images taller than wide take the full viewport
     width and the lightbox container scrolls vertically. Anchored to the
     top so opening the lightbox lands you at the top of the image. */
  .lightbox.tall { overflow-y: auto; align-items: flex-start; justify-content: center; }
  .lightbox.tall .region-stage { max-width: none; max-height: none; width: 100vw; }
  .lightbox.tall .region-stage img { max-width: none; max-height: none; width: 100vw; height: auto; }
  .lightbox .region-overlay { cursor: crosshair; }
  .suite-summary { font-size: 12px; color: #8b949e; margin-top: 4px; }
  .svg-link { font-size: 11px; color: #58a6ff; text-decoration: none; margin-left: auto; }
  .svg-link:hover { text-decoration: underline; }
  .chunk-strip-details { margin-top: 10px; }
  .chunk-strip-details > summary { font-size: 12px; color: #8b949e; cursor: pointer; user-select: none; padding: 4px 0; list-style: none; display: inline-flex; align-items: center; gap: 6px; }
  .chunk-strip-details > summary::-webkit-details-marker { display: none; }
  .chunk-strip-details > summary::before { content: "▸"; display: inline-block; font-size: 10px; color: #58a6ff; transition: transform 0.1s ease-out; }
  .chunk-strip-details[open] > summary::before { transform: rotate(90deg); }
  .chunk-strip-details > summary:hover { color: #e6edf3; }
  .chunk-strip { margin-top: 8px; display: flex; flex-direction: column; gap: 8px; }
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

function Layout({ manifest, manifestJson }: { manifest: ReviewManifest; manifestJson: string }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>SVG Demo Test Review</title>
        {/* eslint-disable-next-line kerfjs/no-raw-with-dynamic-arg -- static CSS string constant */}
        <style>{raw(REVIEW_CSS)}</style>
      </head>
      <body>
        <header>
          <h1>SVG Demo Test Review</h1>
          <div className="controls">
            {/* DM-1660: toggle the result source (local macOS + the 3 CI platforms).
                Options a source hasn't been populated for are disabled. Changing it
                reloads with ?source=<id> (the client wires the onchange). */}
            <label>Source: <select id="source">
              {manifest.sources.map((s) => (
                <option value={s.id} selected={s.id === manifest.activeSource} disabled={!s.present}>
                  {`${s.label}${s.present ? "" : " (no data)"}`}
                </option>
              ))}
            </select></label>
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
              <option value="html-test-unicode">html-test-unicode</option>
              <option value="real-world">real-world</option>
            </select></label>
            <label>Sort: <select id="sort">
              <option value="verdict-desc">Verdict (worst first)</option>
              <option value="coverage-desc">Coverage % (largest first)</option>
              <option value="regions-desc">Regions (most first)</option>
              <option value="diff-desc">Avg diff % (worst first)</option>
              <option value="diff-asc">Avg diff % (best first)</option>
              <option value="name">Name (A→Z)</option>
            </select></label>
            <label className="toggle"><input type="checkbox" id="show-live-svg" /> Live SVG</label>
            <span className="stats" id="stats"></span>
          </div>
          <div className="suite-summary" id="suite-summary"></div>
        </header>
        <main id="cards"></main>
        {/* Lightbox: a region-stage wraps the maximised image so the SVG
            overlay (id=`lb-overlay`) sits directly on top of it. The
            overlay is wired to the source card's `OverlayHandle` via
            `addView()` whenever the lightbox opens, so drag-add /
            resize / delete inside the fullscreen view edits the same
            rects rendered on the in-grid triplet. DM-736. */}
        <div className="lightbox" id="lightbox">
          <div className="region-stage" id="lb-stage">
            <img id="lb-img" alt="" />
            <svg className="region-overlay" id="lb-overlay" preserveAspectRatio="none"></svg>
          </div>
        </div>
        {/* eslint-disable-next-line kerfjs/no-raw-with-dynamic-arg -- payload passes through safeJsonForScript() which escapes "<" so "</script" cannot terminate the tag */}
        <script type="application/json" id="manifest-data">{raw(manifestJson)}</script>
        <script type="module" src="/client.js"></script>
      </body>
    </html>
  );
}

function renderReviewPage(manifest: ReviewManifest): string {
  const manifestJson = safeJsonForScript(manifest);
  return `<!DOCTYPE html>\n${(<Layout manifest={manifest} manifestJson={manifestJson} />).toString()}`;
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
  const clientJs = await bundleClient();
  // DM-1660: the default source is the first PRESENT one (prefer local-macos).
  const defaultSource = (SOURCES.find((s) => sourceIsPresent(s.root)) ?? SOURCES[0]).id;
  if (!SOURCES.some((s) => sourceIsPresent(s.root))) {
    console.warn("⚠ No test results found in any source. Run a local suite (npm run demos:test:*) or");
    console.warn("  download CI results (node tools/run-ci-visual-tests.mjs …) — then refresh the page.");
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://localhost:${port}`);

      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        const src = sourceById(url.searchParams.get("source") ?? defaultSource).id;
        send(res, 200, "text/html; charset=utf-8", renderReviewPage(loadManifest(src)));
        return;
      }

      if (req.method === "GET" && url.pathname === "/client.js") {
        send(res, 200, "application/javascript; charset=utf-8", clientJs);
        return;
      }

      if (req.method === "GET" && url.pathname.startsWith("/img/")) {
        // /img/<source>/<suite>/<filename>
        const parts = url.pathname.slice(5).split("/");
        if (parts.length !== 3) { send(res, 400, "text/plain", "bad path"); return; }
        const [sourceId, suite, fname] = parts;
        if (fname.includes("..") || decodeURIComponent(fname).includes("/")) {
          send(res, 400, "text/plain", "bad path");
          return;
        }
        const root = sourceById(sourceId).root;
        const filePath = resolve(suiteDir(root, suite as SuiteName), decodeURIComponent(fname));
        // DM-1661: cache miss on a lazy CI source → fetch the containing shard, then retry.
        if (!existsSync(filePath) && fname.endsWith(".png")) {
          const meta = readCiSourceMeta(root, suite as SuiteName);
          if (meta != null) {
            const fixtureBase = decodeURIComponent(fname).replace(/-(expected|actual|diff)\.png$/, "");
            const shard = shardForFixture(root, suite as SuiteName, fixtureBase);
            if (shard != null) {
              try { await fetchShard(root, suite as SuiteName, meta, shard); }
              catch (e) { console.warn(`  lazy fetch failed: ${e instanceof Error ? e.message : String(e)}`); }
            }
          }
        }
        if (!existsSync(filePath)) {
          send(res, 404, "text/plain", "not found");
          return;
        }
        send(res, 200, mimeFor(fname), readFileSync(filePath));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/file-ticket") {
        if (settings == null) {
          sendJson(res, 503, { error: "Hot Sheet isn't configured (no port/secret found) — the 'file a ticket' button is unavailable. Browsing the diffs still works." });
          return;
        }
        const body = await readBody(req);
        const parsed = JSON.parse(body) as { source?: string; suite?: string; name?: string; comment?: string; regions?: unknown };
        const source = sourceById(parsed.source ?? defaultSource);
        const manifest = loadManifest(source.id);
        const suite = parsed.suite as SuiteName | undefined;
        const name = parsed.name ?? "";
        const comment = parsed.comment ?? "";
        const regions = sanitizeRegions(parsed.regions);
        const match = manifest.tests.find((r) => r.name === name && r.suite === suite);
        if (match == null) {
          sendJson(res, 400, { error: `Unknown test: ${suite}/${name}` });
          return;
        }
        // Lead the title with the qualitative verdict (clean/trivial/minor/
        // moderate/major) + region count + coverage %. Falls back to raw
        // diff% only for manifests written before the verdict landed.
        const titleScore = match.verdict != null && match.coveragePct != null && match.regionCount != null
          ? `${match.verdict} · ${match.regionCount} regions · ${match.coveragePct.toFixed(2)}% of image`
          : `${match.diffPct.toFixed(2)}% diff`;
        const title = `SVG demo test [${match.suite}]: ${name} (${titleScore})`;
        const regionsBlock = serializeRegions(regions);
        const regionLine = match.regionCount != null
          ? `Score: ${match.verdict ?? "?"} · ${match.regionCount} region${match.regionCount === 1 ? "" : "s"} · ${match.coveragePct != null ? match.coveragePct.toFixed(2) + "%" : "?"} of image · max severity ${match.maxRegionSeverity != null ? match.maxRegionSeverity.toFixed(1) : "?"}% · scatter ${match.scatteredPixels ?? 0} px`
          : null;
        const detailsParts = [
          `Suite: \`${match.suite}\``,
          `Test: \`${name}\``,
          ...(regionLine != null ? [regionLine] : []),
          `Diff (legacy): ${match.diffPct.toFixed(2)}% avg${match.sigPixelPct != null ? ` · sig ${match.sigPixelPct.toFixed(1)}%` : ""}${match.worstTilePct != null ? ` · tile avg ${match.worstTilePct.toFixed(1)}%` : ""}${match.worstTileSignificantPct != null ? ` · tile sig ${match.worstTileSignificantPct.toFixed(1)}%` : ""}`,
          `Status: ${match.skipped ? `SKIP (${match.skipReason ?? "no reason"})` : match.error != null ? `ERROR (${match.error})` : match.pass ? "PASS" : "FAIL"}`,
          `Recorded: ${new Date(manifest.generatedAt).toLocaleString()}`,
          "",
          comment !== "" ? comment : "_(no comment provided)_",
        ];
        if (regionsBlock !== "") {
          detailsParts.push("", regionsBlock);
        }
        if (!match.skipped) {
          const relPath = suiteDir(source.root, match.suite);
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
            const p = imagePathFor(source.root, match, kind);
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
    const manifest = loadManifest(defaultSource);
    const failing = manifest.tests.filter((r) => !r.pass && !r.skipped).length;
    const skipped = manifest.tests.filter((r) => r.skipped).length;
    console.log(`\nSVG Demo Test Review — sources:`);
    for (const s of SOURCES) {
      const present = sourceIsPresent(s.root);
      console.log(`  ${present ? (s.id === defaultSource ? "▶" : "•") : "·"} ${s.label.padEnd(14)} ${present ? "" : "(no data)"}`);
    }
    console.log(`\n  active [${defaultSource}] — ${failing} failing · ${skipped} skipped · ${manifest.tests.length} total`);
    console.log(`  ${url}`);
    console.log(`  (toggle source in the header · Ctrl+C to stop)`);
    try { spawn("open", [url], { stdio: "ignore", detached: true }).unref(); } catch { /* manual open works */ }
  });
}

void main();
