/** @jsxRuntime automatic */
/** @jsxImportSource kerfjs */

/**
 * HTML Test Suite Runner
 *
 * Runs domotion against every HTML file in ~/Documents/html-test.
 * For each file:
 *   1. Render HTML in Playwright (Chromium) -> PNG ("expected")
 *   2. Capture element tree -> SVG -> render SVG -> PNG ("actual")
 *   3. Diff and record result
 *
 * Outputs:
 *   - tests/output/html-test/<name>-{expected,actual,diff}.png
 *   - tests/output/html-test/results.json  (for ticket generation)
 *   - tests/output/html-test/index.html    (visual overview)
 *
 * Usage: npx tsx tests/html-test-suite.tsx [--only 07-svg-shapes]
 */

import { chromium, type BrowserContext, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { captureElementTreeWithWarnings, elementTreeToSvg, embedRemoteImages } from "../src/render/element-tree-to-svg.js";
import { discoverAndRegisterWebfonts } from "../src/capture/index.js";
import { rasterizeConicGradients } from "../src/render/conic-raster.js";
import { raw } from "kerfjs";
import { comparePngs, MIN_REGION_AREA, REGION_DILATE_PX, SIGNIFICANT_PIXEL_DIST, TILE_PX, type DiffVerdict } from "./compare-pngs.js";
import { lowerProcessPriority, resolveWorkerCount, runJobsInPool } from "./worker-pool.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTML_TEST_DIR = resolve(homedir(), "Documents/html-test");
// Anchor output under this package's tests/ regardless of cwd so runs from
// inside  don't create a stray 
// subtree (the reason SK-991 was filed).
const OUTPUT_DIR = resolve(__dirname, "output/html-test");
const WIDTH = 1024;
const HEIGHT = 768;
// Pass criterion, AA detector, and tile metrics are shared with the simpler
// runner via tests/compare-pngs.ts (DM-383). PASS_THRESHOLD_NON_AA_PIXELS,
// TILE_PX, and SIGNIFICANT_PIXEL_DIST are imported above.

/**
 * Tests intentionally deferred because the feature has no SVG equivalent or
 * requires a future refactor tracked by a dedicated ticket. Skipped tests
 * still render (so the artifacts exist for manual inspection) but don't count
 * against the pass/fail tally.
 */
const SKIP_TESTS: Record<string, string> = {
  "22-backdrop-filter": "SVG has no backdrop-filter equivalent in img-rendered SVG",
  "17-gradient-conic": "SVG 2 conic-gradient is not shipped in browsers",
  "17-gradient-repeating": "edge cases in repeating gradient stop spacing — low priority",
  "21-transform-3d": "CSS transforms deferred in SK-435 (layout-coord refactor needed)",
  "21-deep-transform-3d-preserve": "preserve-3d cube composition deferred in SK-435 (same territory as 21-transform-3d)",
  "27-page": "@page rules are print-media only, not relevant to static screen capture",
};

interface TestResult {
  name: string;
  category: string;
  /** Count of pixels that differ between expected and actual AND are not
   *  classified as glyph anti-aliasing by the Yee detector. Diagnostic only;
   *  pass/fail uses `regionCount` (DM-715). */
  nonAaPixels: number;
  /** Same count expressed as a fraction of total image pixels (diagnostic). */
  nonAaPixelPct: number;
  diffPct: number;
  /** Image-wide fraction of pixels with >SIGNIFICANT_PIXEL_DIST distance. */
  sigPixelPct: number;
  /** Worst tile's average color distance as a %. */
  worstTilePct: number;
  /** Worst tile's fraction of pixels with >SIGNIFICANT_PIXEL_DIST distance. */
  worstTileSignificantPct: number;
  /** Rect of the worst tile (x, y, w, h) in the image. */
  worstTileRect?: { x: number; y: number; w: number; h: number };
  /** DM-715: connected-components region count on the dilated non-AA-diff
   *  mask. Pass requires 0. */
  regionCount: number;
  /** Total ORIGINAL non-AA-diff pixel area within surviving regions. */
  totalChangedArea: number;
  /** Max per-pixel normalized color distance % inside any surviving region. */
  maxRegionSeverity: number;
  /** Non-AA-diff pixels that fell into culled (sub-`MIN_REGION_AREA`)
   *  components; treated as scatter and ignored by pass/fail. */
  scatteredPixels: number;
  /** Pixels absorbed by the neighborhood-tolerant shift filter. */
  shiftedPixels: number;
  /** Connected components that passed the area floor but were culled for
   *  low high-severity fraction (typical of font-substitution / glyph-
   *  shape differences). They aren't real structural change. */
  shiftyRegionCount: number;
  shiftyRegionArea: number;
  /** Surviving area as a percentage of the image (more intuitive than the
   *  raw pixel count). */
  coveragePct: number;
  /** Qualitative tier — `clean`/`trivial`/`minor`/`moderate`/`major`. */
  verdict: DiffVerdict;
  /** Per-region breakdown (top 32 by area). */
  regions: Array<{ area: number; maxSeverity: number; highSevFraction: number; x: number; y: number; w: number; h: number }>;
  pass: boolean;
  skipped?: boolean;
  skipReason?: string;
  bodyBg: string;
  error?: string;
  warnings?: Array<{ selector: string; feature: string; detail: string }>;
}


function categoryOf(name: string): string {
  // Subdir-prefixed names (e.g. `niche-foo`) take their subdir as the
  // category. DM-714: added 19 fixtures under `~/Documents/html-test/niche/`
  // for experimental/Chrome-only CSS coverage; bucketed separately so the
  // category breakdown shows their pass rate next to the spec-bucket tests.
  // Subdirectory names must start with a letter so they don't collide with
  // the digit-prefixed spec buckets (`14-float-*` etc). Match only the
  // FIRST hyphen-bounded segment so `niche-text-box-trim` lands in the
  // `niche` bucket rather than `niche-text-box`.
  const sub = /^([a-z][a-z0-9]*)-/.exec(name);
  if (sub != null) return sub[1];
  const m = /^(\d+)-([a-z]+)/.exec(name);
  if (m != null) return `${m[1]}-${m[2]}`;
  return "other";
}

/** DM-714: walk HTML_TEST_DIR recursively. Returns relative paths with `/`
 *  separator (e.g. `niche/foo.html`). Subdirs whose name starts with `.` or
 *  `_` are skipped; everything else under the root is walked. */
function walkHtmlFiles(rootDir: string): string[] {
  const out: string[] = [];
  function visit(dir: string, prefix: string): void {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (name.startsWith(".") || name.startsWith("_")) continue;
      const fullPath = resolve(dir, name);
      const relPath = prefix === "" ? name : `${prefix}/${name}`;
      let isDir = false;
      try { isDir = statSync(fullPath).isDirectory(); } catch { continue; }
      if (isDir) {
        visit(fullPath, relPath);
      } else if (name.endsWith(".html") && relPath !== "index.html") {
        out.push(relPath);
      }
    }
  }
  visit(rootDir, "");
  return out.sort();
}

interface HtmlTestWorker {
  context: BrowserContext;
  page: Page;
  compareContext: BrowserContext;
  comparePage: Page;
}

async function runOneHtmlTest(file: string, w: HtmlTestWorker): Promise<TestResult> {
  // DM-714: `file` is a relative path under HTML_TEST_DIR (e.g. `01-foo.html`
  // or `niche/foo.html`). Flatten subdir separators to `-` so the output
  // PNGs and the visible "name" in results live at the top of OUTPUT_DIR;
  // `srcPath` still resolves correctly through the un-flattened path.
  const name = file.replace(/\.html$/, "").replace(/\//g, "-");
  const srcPath = resolve(HTML_TEST_DIR, file);
  const expectedPath = resolve(OUTPUT_DIR, `${name}-expected.png`);
  const actualPath = resolve(OUTPUT_DIR, `${name}-actual.png`);
  const diffPath = resolve(OUTPUT_DIR, `${name}-diff.png`);
  const svgPath = resolve(OUTPUT_DIR, `${name}.svg`);

  let nonAaPixels = Number.MAX_SAFE_INTEGER;
  let nonAaPixelPct = 100;
  let diffPct = 100;
  let sigPixelPct = 100;
  let worstTilePct = 100;
  let worstTileSignificantPct = 100;
  let worstTileRect: { x: number; y: number; w: number; h: number } | undefined;
  let regionCount = Number.MAX_SAFE_INTEGER;
  let totalChangedArea = 0;
  let maxRegionSeverity = 0;
  let scatteredPixels = 0;
  let shiftedPixels = 0;
  let shiftyRegionCount = 0;
  let shiftyRegionArea = 0;
  let coveragePct = 100;
  let verdict: DiffVerdict = "major";
  let regions: Array<{ area: number; maxSeverity: number; highSevFraction: number; x: number; y: number; w: number; h: number }> = [];
  let bodyBg = "#ffffff";
  let err: string | undefined;
  let capWarnings: Array<{ selector: string; feature: string; detail: string }> = [];

  try {
    await w.page.goto(`file://${srcPath}`);
    await w.page.waitForTimeout(150);

    bodyBg = await w.page.evaluate(() => {
      const cs = getComputedStyle(document.body);
      const bg = cs.backgroundColor;
      if (bg === "rgba(0, 0, 0, 0)" || bg === "transparent") return "#ffffff";
      return bg;
    });

    await w.page.screenshot({ path: expectedPath, clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } });

    // Pick up any @font-face rules — covers both url(...) downloads and
    // local(...) aliases (DM-303). Without this, fixtures using
    // `font-family: "MyFamily"` declared via @font-face render in the
    // chain-fallback face (`serif` → Times) instead of the local() target.
    try { await discoverAndRegisterWebfonts(w.page); } catch { /* best-effort */ }

    // captureElementTreeWithWarnings returns warnings inline so concurrent
    // workers don't race on the lastCaptureWarnings module global (DM-456).
    const cap = await captureElementTreeWithWarnings(w.page, "body", { x: 0, y: 0, width: WIDTH, height: HEIGHT });
    capWarnings = cap.warnings;
    // DM-512: demos always emit self-contained SVGs.
    // DM-527: thread the per-suite warnings array so concurrent workers
    // don't race on the lastCaptureWarnings module global.
    await embedRemoteImages(cap.tree, { warnings: capWarnings });
    // DM-549: rasterize conic-gradient layers (no-op when tree has none).
    await rasterizeConicGradients(cap.tree);
    const svgContent = elementTreeToSvg(cap.tree, WIDTH, HEIGHT);
    const svgDoc = `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}"><rect width="${WIDTH}" height="${HEIGHT}" fill="${bodyBg}" />${svgContent}</svg>`;
    writeFileSync(svgPath, svgDoc);

    // Load the SVG directly as the top-level document. Wrapping it in <img>
    // blocks external resource loads inside the SVG for security, which
    // masked rendering fidelity for any test using background:url() or <img>.
    // Loading the SVG as a document lets those external file:// refs resolve.
    await w.page.goto(`file://${svgPath}`);
    await w.page.waitForTimeout(200);
    await w.page.screenshot({ path: actualPath, clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } });

    const cmp = await comparePngs(w.comparePage, expectedPath, actualPath, diffPath, TILE_PX, SIGNIFICANT_PIXEL_DIST);
    nonAaPixels = cmp.nonAaPixels;
    nonAaPixelPct = cmp.nonAaPixelPct;
    diffPct = cmp.diffPct;
    sigPixelPct = cmp.sigPixelPct;
    worstTilePct = cmp.worstTilePct;
    worstTileSignificantPct = cmp.worstTileSignificantPct;
    worstTileRect = cmp.worstTileRect;
    regionCount = cmp.regionCount;
    totalChangedArea = cmp.totalChangedArea;
    maxRegionSeverity = cmp.maxRegionSeverity;
    scatteredPixels = cmp.scatteredPixels;
    shiftedPixels = cmp.shiftedPixels;
    shiftyRegionCount = cmp.shiftyRegionCount;
    shiftyRegionArea = cmp.shiftyRegionArea;
    coveragePct = cmp.coveragePct;
    verdict = cmp.verdict;
    regions = cmp.regions;
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
  }

  const skipReason = SKIP_TESTS[name];
  const skipped = skipReason != null;
  const pass = !skipped && err == null && regionCount === 0;
  return {
    name,
    category: categoryOf(name),
    nonAaPixels,
    nonAaPixelPct,
    diffPct,
    sigPixelPct,
    worstTilePct,
    worstTileSignificantPct,
    worstTileRect,
    regionCount,
    totalChangedArea,
    maxRegionSeverity,
    scatteredPixels,
    shiftedPixels,
    shiftyRegionCount,
    shiftyRegionArea,
    coveragePct,
    verdict,
    regions,
    pass,
    skipped,
    skipReason,
    bodyBg,
    error: err,
    warnings: capWarnings.length > 0 ? capWarnings : undefined,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const onlyArg = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;

  mkdirSync(OUTPUT_DIR, { recursive: true });

  // DM-714: walk recursively so subdir-grouped fixtures (`niche/*.html`,
  // future additions) are picked up automatically.
  const files = walkHtmlFiles(HTML_TEST_DIR);

  // --only is matched against the flattened name (with `/` → `-`) so callers
  // can pass either form: `--only niche-foo` and `--only niche/foo` both work.
  const onlyNorm = onlyArg != null ? onlyArg.replace(/\//g, "-") : null;
  const testFiles = onlyNorm != null
    ? files.filter((f) => f.replace(/\//g, "-").startsWith(onlyNorm))
    : files;
  if (testFiles.length === 0) {
    console.log(`No test files matched (onlyArg=${onlyArg ?? "(none)"}).`);
    return;
  }

  // DM-459: yield CPU to interactive work — Chromium subprocesses inherit.
  lowerProcessPriority();
  const workerCount = resolveWorkerCount();
  console.log(`Running ${testFiles.length} html-test files (viewport ${WIDTH}x${HEIGHT}) with ${workerCount} workers...\n`);

  const browser = await chromium.launch();

  const results = await runJobsInPool<string, HtmlTestWorker, TestResult>({
    jobs: testFiles,
    workers: workerCount,
    setup: async () => {
      const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT } });
      const page = await context.newPage();
      // DM-479: 90 s instead of Playwright's 30 s default.
      page.setDefaultTimeout(90_000);
      page.setDefaultNavigationTimeout(90_000);
      const compareContext = await browser.newContext({ viewport: { width: WIDTH * 2, height: HEIGHT } });
      const comparePage = await compareContext.newPage();
      comparePage.setDefaultTimeout(90_000);
      comparePage.setDefaultNavigationTimeout(90_000);
      await comparePage.goto("about:blank");
      return { context, page, compareContext, comparePage };
    },
    teardown: async (w) => {
      await w.context.close();
      await w.compareContext.close();
    },
    runJob: async (file, w) => runOneHtmlTest(file, w),
    onResult: (result) => {
      const { name, pass, skipped, error: err, warnings, verdict, regionCount, coveragePct } = result;
      const status = skipped ? "- SKIP" : pass ? "✓ PASS" : "✗ FAIL";
      const warnBadge = warnings != null ? ` (${warnings.length}w)` : "";
      // Headline: verdict tier + region count + coverage %. Three things,
      // each immediately interpretable: "minor" tells you it's small,
      // "3 regions" tells you how many spots to look at, "0.28% of image"
      // tells you how much area is wrong.
      const headline = (skipped ?? false)
        ? ""
        : ` ${verdict} · ${regionCount} region${regionCount === 1 ? "" : "s"} · ${coveragePct.toFixed(2)}% of image`;
      console.log(`  ${status}  ${name.padEnd(40)}${headline}${warnBadge}${err != null ? `  ERR: ${err}` : ""}`);
    },
  });

  await browser.close();

  writeFileSync(resolve(OUTPUT_DIR, "results.json"), JSON.stringify(results, null, 2));

  const indexHtml = buildIndexHtml(results);
  writeFileSync(resolve(OUTPUT_DIR, "index.html"), indexHtml);

  const passed = results.filter((r) => r.pass).length;
  const skipped = results.filter((r) => r.skipped).length;
  const failed = results.length - passed - skipped;
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped out of ${results.length}`);
  console.log(`\nArtifacts: ${OUTPUT_DIR}`);
  console.log(`Visual index: file://${resolve(OUTPUT_DIR, "index.html")}`);

  const byCategory = new Map<string, { total: number; failed: number; avgDiff: number }>();
  for (const r of results) {
    const entry = byCategory.get(r.category) ?? { total: 0, failed: 0, avgDiff: 0 };
    entry.total++;
    entry.avgDiff += r.diffPct;
    if (!r.pass) entry.failed++;
    byCategory.set(r.category, entry);
  }

  console.log(`\nBy category (category: fails/total avg%):`);
  const catKeys = Array.from(byCategory.keys()).sort();
  for (const key of catKeys) {
    const v = byCategory.get(key)!;
    console.log(`  ${key.padEnd(24)} ${v.failed}/${v.total}  avg ${(v.avgDiff / v.total).toFixed(1)}%`);
  }

  if (failed > 0) process.exitCode = 1;
}

const INDEX_CSS = `
body{font:13px -apple-system,sans-serif;margin:16px;background:#f6f8fa}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #e1e4e8;vertical-align:top}
tr.pass{background:#f0fff4}
tr.fail{background:#fff5f5}
tr.skip{background:#f6f8fa;opacity:0.7}
.name{font-family:monospace;font-size:12px}
.status{font-weight:600}
.tile{color:#6e7681;font-size:11px}
.imgs img{width:180px;height:135px;object-fit:contain;background:#fff;border:1px solid #d0d7de;margin-right:4px}
h1{margin:0 0 12px}
.err{color:#cf222e;font-family:monospace;font-size:11px}
.skip-note{color:#8b949e;font-size:11px;font-style:italic;margin-top:4px}
.warn-list{font-size:11px;color:#6e7681;margin:4px 0 0 14px;padding:0}
.warn-list li{margin:1px 0}
.legend{font-size:12px;color:#6e7681;margin-bottom:8px}
`;

function ResultRow({ r }: { r: TestResult }) {
  const status = r.skipped ? "SKIP" : r.pass ? "PASS" : "FAIL";
  const cls = r.skipped ? "skip" : r.pass ? "pass" : "fail";
  return (
    <tr className={cls}>
      <td className="name">{r.name}</td>
      <td className="status">{status}</td>
      <td className="diff">
        <div><b>{`${r.verdict} · ${r.regionCount} region${r.regionCount === 1 ? "" : "s"}`}</b></div>
        <div className="tile">{`${r.coveragePct.toFixed(2)}% of image`}</div>
        <div className="tile">{`shifty ${r.shiftyRegionCount} · shifted ${r.shiftedPixels} · scatter ${r.scatteredPixels}`}</div>
        <div className="tile">{`raw avg ${r.diffPct.toFixed(2)}% · non-AA ${r.nonAaPixels} px`}</div>
      </td>
      <td className="imgs">
        <a href={`${r.name}-expected.png`}><img src={`${r.name}-expected.png`} /></a>
        <a href={`${r.name}-actual.png`}><img src={`${r.name}-actual.png`} /></a>
        <a href={`${r.name}-diff.png`}><img src={`${r.name}-diff.png`} /></a>
      </td>
      <td className="err-cell">
        {r.error != null ? <div className="err">{r.error}</div> : null}
        {r.skipReason != null ? <div className="skip-note">{`skipped: ${r.skipReason}`}</div> : null}
        {(r.warnings ?? []).length > 0 ? (
          <ul className="warn-list">
            {(r.warnings ?? []).map((w) => (
              <li><b>{w.feature}</b>{` · ${w.selector} — ${w.detail}`}</li>
            ))}
          </ul>
        ) : null}
      </td>
    </tr>
  );
}

function MetricsLegend() {
  return (
    <p className="legend">
      {`Verdicts: clean (no regions) · trivial (≤2 regions, <0.05% coverage) · minor (≤5 regions, <0.5%) · moderate (≤15 regions, <2%) · major (everything past that). Pipeline (DM-715): neighborhood-tolerant shift filter → Yee AA filter → 3-px dilation + flood-fill → area + high-severity gates. "shifty" = font-substitution regions culled by the high-sev gate; "scatter" = sub-area components; "shifted" = pixels absorbed by neighborhood matching. Big shifty/shifted with low region count means the filters did real work. Magenta outlines on diff.png mark surviving regions; yellow box marks the worst tile.`}
    </p>
  );
}

function IndexLayout({ results }: { results: TestResult[] }) {
  const passCount = results.filter((r) => r.pass).length;
  const failCount = results.filter((r) => !r.pass && !r.skipped).length;
  const skipCount = results.filter((r) => r.skipped).length;
  return (
    <html>
      <head>
        <meta charset="utf-8" />
        <title>domotion html-test results</title>
        <style>{raw(INDEX_CSS)}</style>
      </head>
      <body>
        <h1>{`domotion vs html-test (${results.length} files; ${passCount} pass · ${failCount} fail · ${skipCount} skip)`}</h1>
        <MetricsLegend />
        <table>
          <thead><tr><th>File</th><th>Status</th><th>Diff</th><th>Expected · Actual · Diff</th><th>Notes</th></tr></thead>
          <tbody>
            {results.map((r) => <ResultRow r={r} />)}
          </tbody>
        </table>
      </body>
    </html>
  );
}

function buildIndexHtml(results: TestResult[]): string {
  return `<!DOCTYPE html>${(<IndexLayout results={results} />).toString()}`;
}

void main();
