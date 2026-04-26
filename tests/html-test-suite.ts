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
 * Usage: npx tsx tests/html-test-suite.ts [--only 07-svg-shapes]
 */

import { chromium, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { captureElementTree, elementTreeToSvg, getLastCaptureWarnings } from "../src/dom-to-svg.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTML_TEST_DIR = resolve(homedir(), "Documents/html-test");
// Anchor output under this package's tests/ regardless of cwd so runs from
// inside  don't create a stray 
// subtree (the reason SK-991 was filed).
const OUTPUT_DIR = resolve(__dirname, "output/html-test");
const WIDTH = 1024;
const HEIGHT = 768;
// Pass requires ALL thresholds. Three metrics together catch the failure modes
// we saw slip past a single average check:
//   1. avg color distance — reasonable antialias-drift budget across whole image.
//   2. worst-tile avg — catches a big solid-color mismatch concentrated in one region.
//   3. worst-tile significant-diff % — counts pixels with visible color delta (>24)
//      inside each tile. This is the metric that flags "content appears where
//      nothing should be" / "missing whole widget" — the text pixels blow this
//      metric even when the tile's raw average stays low because the white
//      background between text dilutes it.
// Thresholds calibrated against the text-drift floor: path-mode rendering via
// fontkit produces glyph shapes that differ from Chromiums hinted+antialiased
// text by ~1-2 pixels per glyph. Across a text-heavy page this accumulates to
// ~3-3.5% avg diff and ~6-7% significant-pixel % even when the layout is
// pixel-exact. Thresholds set just above this floor so structurally broken
// renders fail (>5% avg, >50% tile-sig) while clean-but-drifted text passes.
// See SK-539 for the investigation.
const PASS_THRESHOLD_AVG = 3.5;
const PASS_THRESHOLD_TILE = 25;
const PASS_THRESHOLD_TILE_SIGNIFICANT = 50;
const PASS_THRESHOLD_SIG_PIXELS = 7;
const TILE_PX = 64;
// Per-pixel distance threshold (0..441) above which a pixel counts as "clearly
// different" rather than antialias noise. 40 is ~9% of max distance — tuned to
// skip typical path-mode glyph antialiasing drift but still flag an unexpected
// dark stroke against white background.
const SIGNIFICANT_PIXEL_DIST = 40;

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
  "27-page": "@page rules are print-media only, not relevant to static screen capture",
};

interface TestResult {
  name: string;
  category: string;
  diffPct: number;
  /** Image-wide fraction of pixels with >SIGNIFICANT_PIXEL_DIST distance. */
  sigPixelPct: number;
  /** Worst tile's average color distance as a %. */
  worstTilePct: number;
  /** Worst tile's fraction of pixels with >SIGNIFICANT_PIXEL_DIST distance. */
  worstTileSignificantPct: number;
  /** Rect of the worst tile (x, y, w, h) in the image. */
  worstTileRect?: { x: number; y: number; w: number; h: number };
  pass: boolean;
  skipped?: boolean;
  skipReason?: string;
  bodyBg: string;
  error?: string;
  warnings?: Array<{ selector: string; feature: string; detail: string }>;
}

interface CompareResult {
  diffPct: number;
  sigPixelPct: number;
  worstTilePct: number;
  worstTileSignificantPct: number;
  worstTileRect: { x: number; y: number; w: number; h: number };
}

async function comparePngs(
  page: Page,
  expectedPath: string,
  actualPath: string,
  diffPath: string,
  tilePx: number,
  significantDist: number,
): Promise<CompareResult> {
  const expectedB64 = readFileSync(expectedPath).toString("base64");
  const actualB64 = readFileSync(actualPath).toString("base64");

  const result = (await page.evaluate(
    `(async () => {
      const loadImg = (src) => new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
      });
      const [expected, actual] = await Promise.all([
        loadImg("data:image/png;base64,${expectedB64}"),
        loadImg("data:image/png;base64,${actualB64}")
      ]);
      const w = Math.max(expected.width, actual.width);
      const h = Math.max(expected.height, actual.height);
      const c1 = document.createElement("canvas"); c1.width = w; c1.height = h;
      c1.getContext("2d").drawImage(expected, 0, 0);
      const d1 = c1.getContext("2d").getImageData(0, 0, w, h).data;
      const c2 = document.createElement("canvas"); c2.width = w; c2.height = h;
      c2.getContext("2d").drawImage(actual, 0, 0);
      const d2 = c2.getContext("2d").getImageData(0, 0, w, h).data;
      const diffCanvas = document.createElement("canvas");
      diffCanvas.width = w; diffCanvas.height = h;
      const diffCtx = diffCanvas.getContext("2d");
      const diffData = diffCtx.createImageData(w, h);
      const maxDist = Math.sqrt(255 * 255 * 3);
      const TILE = ${tilePx};
      const SIG = ${significantDist};
      const tilesX = Math.ceil(w / TILE);
      const tilesY = Math.ceil(h / TILE);
      // Accumulate per-tile normalized distance and significant-pixel count.
      const tileDist = new Float64Array(tilesX * tilesY);
      const tileSig = new Uint32Array(tilesX * tilesY);
      const tilePixCount = new Uint32Array(tilesX * tilesY);
      let totalDist = 0;
      let totalSig = 0;
      const totalPixels = w * h;
      for (let y = 0; y < h; y++) {
        const ty = (y / TILE) | 0;
        for (let x = 0; x < w; x++) {
          const tx = (x / TILE) | 0;
          const i = (y * w + x) * 4;
          const dr = d1[i] - d2[i];
          const dg = d1[i+1] - d2[i+1];
          const db = d1[i+2] - d2[i+2];
          const dist = Math.sqrt(dr*dr + dg*dg + db*db);
          const norm = dist / maxDist;
          totalDist += norm;
          const ti = ty * tilesX + tx;
          tileDist[ti] += norm;
          tilePixCount[ti]++;
          if (dist > SIG) { tileSig[ti]++; totalSig++; }
          const intensity = Math.min(255, dist * 2);
          if (intensity > 8) {
            diffData.data[i] = intensity; diffData.data[i+1] = 0; diffData.data[i+2] = 0; diffData.data[i+3] = 255;
          } else {
            diffData.data[i] = d1[i] * 0.3; diffData.data[i+1] = d1[i+1] * 0.3; diffData.data[i+2] = d1[i+2] * 0.3; diffData.data[i+3] = 255;
          }
        }
      }
      // Find worst tile by significant-pixel ratio (primary), with avg as
      // tiebreak. This catches "content where there shouldn't be any" even
      // when diluted by surrounding whitespace.
      let worstSigPct = 0, worstAvgPct = 0, worstIdx = 0;
      for (let i = 0; i < tileDist.length; i++) {
        if (tilePixCount[i] === 0) continue;
        const sigPct = (tileSig[i] / tilePixCount[i]) * 100;
        const avgPct = (tileDist[i] / tilePixCount[i]) * 100;
        if (sigPct > worstSigPct || (sigPct === worstSigPct && avgPct > worstAvgPct)) {
          worstSigPct = sigPct;
          worstAvgPct = avgPct;
          worstIdx = i;
        }
      }
      const worstTx = worstIdx % tilesX;
      const worstTy = (worstIdx / tilesX) | 0;
      // Outline worst tile in yellow so humans can find it in the diff image.
      const ox = worstTx * TILE, oy = worstTy * TILE;
      const ow = Math.min(TILE, w - ox), oh = Math.min(TILE, h - oy);
      for (let dx = 0; dx < ow; dx++) {
        const top = (oy * w + (ox + dx)) * 4;
        const bot = ((oy + oh - 1) * w + (ox + dx)) * 4;
        diffData.data[top] = 255; diffData.data[top+1] = 220; diffData.data[top+2] = 0; diffData.data[top+3] = 255;
        diffData.data[bot] = 255; diffData.data[bot+1] = 220; diffData.data[bot+2] = 0; diffData.data[bot+3] = 255;
      }
      for (let dy = 0; dy < oh; dy++) {
        const lft = ((oy + dy) * w + ox) * 4;
        const rgt = ((oy + dy) * w + (ox + ow - 1)) * 4;
        diffData.data[lft] = 255; diffData.data[lft+1] = 220; diffData.data[lft+2] = 0; diffData.data[lft+3] = 255;
        diffData.data[rgt] = 255; diffData.data[rgt+1] = 220; diffData.data[rgt+2] = 0; diffData.data[rgt+3] = 255;
      }
      diffCtx.putImageData(diffData, 0, 0);
      return {
        diffPercent: (totalDist / totalPixels) * 100,
        sigPixelPct: (totalSig / totalPixels) * 100,
        worstTilePct: worstAvgPct,
        worstTileSignificantPct: worstSigPct,
        worstTileRect: { x: ox, y: oy, w: ow, h: oh },
        diffDataUrl: diffCanvas.toDataURL("image/png"),
      };
    })()`,
  )) as { diffPercent: number; sigPixelPct: number; worstTilePct: number; worstTileSignificantPct: number; worstTileRect: { x: number; y: number; w: number; h: number }; diffDataUrl: string };

  writeFileSync(diffPath, Buffer.from(result.diffDataUrl.split(",")[1], "base64"));
  return {
    diffPct: result.diffPercent,
    sigPixelPct: result.sigPixelPct,
    worstTilePct: result.worstTilePct,
    worstTileSignificantPct: result.worstTileSignificantPct,
    worstTileRect: result.worstTileRect,
  };
}

function categoryOf(name: string): string {
  const m = /^(\d+)-([a-z]+)/.exec(name);
  if (m != null) return `${m[1]}-${m[2]}`;
  return "other";
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const onlyArg = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;

  mkdirSync(OUTPUT_DIR, { recursive: true });

  const files = readdirSync(HTML_TEST_DIR)
    .filter((f) => f.endsWith(".html") && f !== "index.html")
    .sort();

  const testFiles = onlyArg != null ? files.filter((f) => f.startsWith(onlyArg)) : files;
  if (testFiles.length === 0) {
    console.log(`No test files matched (onlyArg=${onlyArg ?? "(none)"}).`);
    return;
  }

  console.log(`Running ${testFiles.length} html-test files (viewport ${WIDTH}x${HEIGHT})...\n`);

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT } });
  const page = await context.newPage();

  const compareContext = await browser.newContext({ viewport: { width: WIDTH * 2, height: HEIGHT } });
  const comparePage = await compareContext.newPage();
  await comparePage.goto("about:blank");

  const results: TestResult[] = [];

  for (const file of testFiles) {
    const name = file.replace(/\.html$/, "");
    const srcPath = resolve(HTML_TEST_DIR, file);
    const expectedPath = resolve(OUTPUT_DIR, `${name}-expected.png`);
    const actualPath = resolve(OUTPUT_DIR, `${name}-actual.png`);
    const diffPath = resolve(OUTPUT_DIR, `${name}-diff.png`);
    const svgPath = resolve(OUTPUT_DIR, `${name}.svg`);
    const svgRenderPath = resolve(OUTPUT_DIR, `${name}-svg-render.html`);

    let diffPct = 100;
    let sigPixelPct = 100;
    let worstTilePct = 100;
    let worstTileSignificantPct = 100;
    let worstTileRect: { x: number; y: number; w: number; h: number } | undefined;
    let bodyBg = "#ffffff";
    let err: string | undefined;
    let capWarnings: Array<{ selector: string; feature: string; detail: string }> = [];

    try {
      await page.goto(`file://${srcPath}`);
      await page.waitForTimeout(150);

      bodyBg = await page.evaluate(() => {
        const cs = getComputedStyle(document.body);
        const bg = cs.backgroundColor;
        if (bg === "rgba(0, 0, 0, 0)" || bg === "transparent") return "#ffffff";
        return bg;
      });

      await page.screenshot({ path: expectedPath, clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } });

      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: WIDTH, height: HEIGHT });
      capWarnings = getLastCaptureWarnings();
      const svgContent = elementTreeToSvg(tree, WIDTH, HEIGHT);
      const svgDoc = `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}"><rect width="${WIDTH}" height="${HEIGHT}" fill="${bodyBg}" />${svgContent}</svg>`;
      writeFileSync(svgPath, svgDoc);

      // Load the SVG directly as the top-level document. Wrapping it in <img>
      // blocks external resource loads inside the SVG for security, which
      // masked rendering fidelity for any test using background:url() or <img>.
      // Loading the SVG as a document lets those external file:// refs resolve.
      // svgRenderPath is kept around only for debug parity — not used anymore.
      void svgRenderPath;
      await page.goto(`file://${svgPath}`);
      await page.waitForTimeout(200);
      await page.screenshot({ path: actualPath, clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } });

      const cmp = await comparePngs(comparePage, expectedPath, actualPath, diffPath, TILE_PX, SIGNIFICANT_PIXEL_DIST);
      diffPct = cmp.diffPct;
      sigPixelPct = cmp.sigPixelPct;
      worstTilePct = cmp.worstTilePct;
      worstTileSignificantPct = cmp.worstTileSignificantPct;
      worstTileRect = cmp.worstTileRect;
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }

    const skipReason = SKIP_TESTS[name];
    const skipped = skipReason != null;
    const pass = !skipped && err == null
      && diffPct < PASS_THRESHOLD_AVG
      && worstTilePct < PASS_THRESHOLD_TILE
      && worstTileSignificantPct < PASS_THRESHOLD_TILE_SIGNIFICANT
      && sigPixelPct < PASS_THRESHOLD_SIG_PIXELS;
    const result: TestResult = {
      name,
      category: categoryOf(name),
      diffPct,
      sigPixelPct,
      worstTilePct,
      worstTileSignificantPct,
      worstTileRect,
      pass,
      skipped,
      skipReason,
      bodyBg,
      error: err,
      warnings: capWarnings.length > 0 ? capWarnings : undefined,
    };
    results.push(result);
    const status = skipped ? "- SKIP" : pass ? "✓ PASS" : "✗ FAIL";
    const warnBadge = result.warnings != null ? ` (${result.warnings.length}w)` : "";
    const tileBadge = !skipped ? ` [sig ${sigPixelPct.toFixed(1)}% · tile avg ${worstTilePct.toFixed(1)}% / sig ${worstTileSignificantPct.toFixed(1)}%]` : "";
    console.log(`  ${status}  ${name.padEnd(40)} (${diffPct.toFixed(2)}% avg${tileBadge})${warnBadge}${err != null ? `  ERR: ${err}` : ""}`);
  }

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

function buildIndexHtml(results: TestResult[]): string {
  const rows = results
    .map((r) => {
      const status = r.skipped ? "SKIP" : r.pass ? "PASS" : "FAIL";
      const cls = r.skipped ? "skip" : r.pass ? "pass" : "fail";
      const err = r.error != null ? `<div class="err">${escapeHtml(r.error)}</div>` : "";
      const warnList = (r.warnings ?? []).map((w) => `<li><b>${escapeHtml(w.feature)}</b> · ${escapeHtml(w.selector)} — ${escapeHtml(w.detail)}</li>`).join("");
      const warnBlock = warnList !== "" ? `<ul class="warn-list">${warnList}</ul>` : "";
      const skipLabel = r.skipReason != null ? `<div class="skip-note">skipped: ${escapeHtml(r.skipReason)}</div>` : "";
      return `
    <tr class="${cls}">
      <td class="name">${r.name}</td>
      <td class="status">${status}</td>
      <td class="diff"><div>avg ${r.diffPct.toFixed(2)}%</div><div class="tile">sig ${r.sigPixelPct.toFixed(1)}%</div><div class="tile">tile avg ${r.worstTilePct.toFixed(1)}%</div><div class="tile">tile sig ${r.worstTileSignificantPct.toFixed(1)}%</div></td>
      <td class="imgs">
        <a href="${r.name}-expected.png"><img src="${r.name}-expected.png" /></a>
        <a href="${r.name}-actual.png"><img src="${r.name}-actual.png" /></a>
        <a href="${r.name}-diff.png"><img src="${r.name}-diff.png" /></a>
      </td>
      <td class="err-cell">${err}${skipLabel}${warnBlock}</td>
    </tr>`;
    })
    .join("");
  const passCount = results.filter((r) => r.pass).length;
  const failCount = results.filter((r) => !r.pass && !r.skipped).length;
  const skipCount = results.filter((r) => r.skipped).length;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>domotion html-test results</title>
<style>
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
</style></head><body>
<h1>domotion vs html-test (${results.length} files; ${passCount} pass · ${failCount} fail · ${skipCount} skip)</h1>
<p class="legend">Pass needs ALL: avg &lt; ${PASS_THRESHOLD_AVG}% AND image-wide significant pixels &lt; ${PASS_THRESHOLD_SIG_PIXELS}% AND worst-tile avg &lt; ${PASS_THRESHOLD_TILE}% AND worst-tile significant &lt; ${PASS_THRESHOLD_TILE_SIGNIFICANT}%. Significant pixels are those with color distance &gt; ${SIGNIFICANT_PIXEL_DIST}/441 (above antialias drift, below). The yellow box in diff.png marks the worst tile. Warnings below list known feature gaps surfaced during capture.</p>
<table>
<thead><tr><th>File</th><th>Status</th><th>Diff</th><th>Expected · Actual · Diff</th><th>Notes</th></tr></thead>
<tbody>${rows}</tbody>
</table></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

void main();
