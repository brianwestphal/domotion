/** @jsxRuntime automatic */
/** @jsxImportSource #jsx */

/**
 * Real-World Test Suite (DM-454)
 *
 * Captures real public marketing sites at desktop and mobile viewport
 * sizes, runs them through Domotion's capture/render pipeline, and diffs
 * the SVG-rendered PNG against the Chromium PNG. Three variants per
 * (site × viewport):
 *
 *   - `*-fold`        : viewport-clipped screenshot (above the fold)
 *   - `*-entire-page` : single full-page screenshot (entire scroll height,
 *                       capped at FULL_PAGE_MAX_H so the diff canvas stays
 *                       tractable)
 *   - `*-scroll`      : animated SVG that scrolls through the captured
 *                       page over time inside the viewport-sized frame
 *                       (no diff metric — the artifact IS the animation)
 *
 * The diff metric is best-effort on every variant; even `*-fold` rarely
 * passes because real pages have non-deterministic content. The artifacts
 * still land in the review tool so a reviewer can inspect Chromium-vs-
 * Domotion side-by-side, and the animated `.svg` is linkable from each
 * card so the scroll animation can be played back.
 *
 * Outputs:
 *   tests/output/real-world/<test>-{expected,actual,diff}.png
 *   tests/output/real-world/<test>.svg
 *   tests/output/real-world/results.json   (consumed by review-server)
 *
 * Usage: npx tsx tests/real-world.tsx [--only google-desktop-fold]
 */

import { chromium, type Browser, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { captureElementTree, elementTreeToSvg, getLastCaptureWarnings } from "../src/dom-to-svg.js";
import { discoverAndRegisterWebfonts } from "../src/capture.js";
import { comparePngs } from "./compare-pngs.js";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = resolve(TESTS_DIR, "output/real-world");

interface Site { name: string; url: string }
const SITES: Site[] = [
  { name: "google",   url: "https://www.google.com/" },
  { name: "apple",    url: "https://www.apple.com/" },
  { name: "nytimes",  url: "https://www.nytimes.com/" },
  { name: "slashdot", url: "https://slashdot.org/" },
  { name: "stripe",   url: "https://stripe.com/" },
  { name: "resend",   url: "https://resend.com/" },
  { name: "framer",   url: "https://www.framer.com/" },
];

interface Viewport { name: string; width: number; height: number; isMobile: boolean }
const VIEWPORTS: Viewport[] = [
  { name: "desktop", width: 1280, height: 800, isMobile: false },
  { name: "mobile",  width:  390, height: 844, isMobile: true  },
];

// Cap entire-page captures so multi-megapixel scrolls don't make the diff
// canvas explode (compare-pngs decodes both PNGs into ImageData buffers).
// 6000 px tall × 1280 wide ≈ 30 MP — already heavy but tractable.
const FULL_PAGE_MAX_H = 6000;

// Network/rendering settle time after page load. Marketing pages defer
// hero animations and lazy-load below-the-fold blocks, so allow a generous
// beat after `domcontentloaded` before capturing.
const SETTLE_MS = 3000;

// Per-site goto timeout. Some marketing pages keep beacons firing past
// `load`, so we use `domcontentloaded` + a fixed settle window instead of
// the default. 60 s allowance for the DOM-ready event covers most slow
// CDNs and TLS handshakes without making the suite hang forever on a
// genuinely broken site.
const GOTO_TIMEOUT_MS = 60_000;

// Length of the scroll-through animation. Long enough to read the page
// at a comfortable scroll speed without inflating SVG file size.
const SCROLL_ANIM_MS = 12_000;

type Mode = "fold" | "entire-page" | "scroll";
const MODES: Mode[] = ["fold", "entire-page", "scroll"];

interface Result {
  name: string;
  site: string;
  viewport: string;
  mode: Mode;
  pass: boolean;
  diffPct: number;
  sigPixelPct: number;
  worstTilePct: number;
  worstTileSignificantPct: number;
  nonAaPixels: number;
  nonAaPixelPct: number;
  /** Captured canvas width (always the viewport width). */
  width: number;
  /** Captured canvas height. For `fold` and `scroll` this is the viewport
   *  height. For `entire-page` it's the (capped) full document scroll
   *  height — what the diff was actually computed on. */
  height: number;
  error?: string;
  skipped?: boolean;
  skipReason?: string;
  /** Capture warnings (unsupported features). Stored as an array so the
   *  review-server's `Array.isArray(r["warnings"])` count is correct. */
  warnings?: Array<{ selector: string; feature: string; detail: string }>;
}

interface PageJob {
  test: string;          // e.g. "google-desktop-fold"
  site: Site;
  viewport: Viewport;
  mode: Mode;
}

function buildJobs(): PageJob[] {
  const out: PageJob[] = [];
  for (const site of SITES) {
    for (const vp of VIEWPORTS) {
      for (const mode of MODES) {
        out.push({ test: `${site.name}-${vp.name}-${mode}`, site, viewport: vp, mode });
      }
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;

  mkdirSync(OUTPUT_DIR, { recursive: true });

  const allJobs = buildJobs();
  const jobs = only != null ? allJobs.filter((j) => j.test.startsWith(only)) : allJobs;
  if (jobs.length === 0) {
    console.log(`No jobs matched (only=${only ?? "(none)"}).`);
    return;
  }

  console.log(`Running ${jobs.length} real-world capture jobs (${VIEWPORTS.length} viewports × ${MODES.length} modes × ${SITES.length} sites)...\n`);

  const browser = await chromium.launch();

  // One compare context shared across all jobs so we don't keep tearing
  // down/recreating canvases. Sized at the worst-case width.
  const compareContext = await browser.newContext({
    viewport: { width: 1280 * 2, height: 800 },
  });
  const comparePage = await compareContext.newPage();
  await comparePage.goto("about:blank");

  const newResults: Result[] = [];
  for (const job of jobs) {
    const result = await runJob(browser, comparePage, job);
    newResults.push(result);
    const status = result.skipped ? "- SKIP"
      : result.error != null    ? "✗ ERROR"
      : result.pass             ? "✓ PASS"
      :                            "✗ FAIL";
    const note = result.error != null
      ? `  ERR: ${result.error}`
      : result.skipped
        ? `  (${result.skipReason ?? "skipped"})`
        : ` (${result.diffPct.toFixed(2)}% avg · ${result.width}×${result.height})`;
    console.log(`  ${status}  ${job.test.padEnd(38)}${note}`);
  }

  await browser.close();

  // Merge `newResults` into any existing manifest so partial runs (--only)
  // don't wipe out results from prior runs. Indexed by test name.
  const merged = mergeResults(newResults);
  writeFileSync(
    resolve(OUTPUT_DIR, "results.json"),
    JSON.stringify({
      suite: "real-world",
      generatedAt: new Date().toISOString(),
      results: merged,
    }, null, 2),
  );

  const passed = newResults.filter((r) => r.pass).length;
  const failed = newResults.filter((r) => !r.pass && !r.skipped && r.error == null).length;
  const errored = newResults.filter((r) => r.error != null).length;
  console.log(`\n${passed} passed, ${failed} failed, ${errored} errored out of ${newResults.length} (this run)`);
  console.log(`Manifest: ${merged.length} total entries`);
  console.log(`Artifacts: ${OUTPUT_DIR}`);
  console.log(`Review: npx tsx tests/review-server.tsx`);
}

/**
 * Merge a partial run's results into the on-disk manifest. New entries
 * replace prior entries with the same `name`; entries the partial run
 * didn't touch are kept. Result order is the canonical job order so
 * the review tool sorts predictably.
 */
function mergeResults(newResults: Result[]): Result[] {
  const existingPath = resolve(OUTPUT_DIR, "results.json");
  let prior: Result[] = [];
  if (existsSync(existingPath)) {
    try {
      const parsed = JSON.parse(readFileSync(existingPath, "utf8")) as { results?: Result[] };
      prior = parsed.results ?? [];
    } catch { /* corrupt manifest — start fresh */ }
  }
  const byName = new Map<string, Result>();
  for (const r of prior) byName.set(r.name, r);
  for (const r of newResults) byName.set(r.name, r);
  // Sort by canonical job order; entries for jobs no longer in the suite
  // (e.g. an old `*-scroll` from before the rename) trail in alpha order.
  const order = new Map<string, number>();
  buildJobs().forEach((j, i) => order.set(j.test, i));
  return [...byName.values()].sort((a, b) => {
    const ai = order.get(a.name) ?? Number.MAX_SAFE_INTEGER;
    const bi = order.get(b.name) ?? Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
    return a.name.localeCompare(b.name);
  });
}

async function runJob(
  browser: Browser,
  comparePage: Page,
  job: PageJob,
): Promise<Result> {
  const { test, site, viewport, mode } = job;
  const expectedPath = resolve(OUTPUT_DIR, `${test}-expected.png`);
  const actualPath = resolve(OUTPUT_DIR, `${test}-actual.png`);
  const diffPath = resolve(OUTPUT_DIR, `${test}-diff.png`);
  const svgPath = resolve(OUTPUT_DIR, `${test}.svg`);

  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
    isMobile: viewport.isMobile,
    hasTouch: viewport.isMobile,
    // A current-ish desktop / mobile UA so sites don't redirect us to a
    // legacy page. (Headless Chromium's default UA confuses some servers
    // into serving cut-down templates.)
    userAgent: viewport.isMobile
      ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"
      : "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();

  let warnings: Array<{ selector: string; feature: string; detail: string }> = [];
  let captureError: string | undefined;

  // Capture canvas height. `fold` / `scroll` always run at viewport size;
  // `entire-page` resizes to the document scroll height after measuring.
  let canvasH = viewport.height;

  try {
    // `domcontentloaded` is more reliable than `load` on real-world pages
    // — `load` waits for every <img>, including beacons that never settle.
    // We trade that off for a fixed SETTLE_MS window after DOMContentLoaded.
    await page.goto(site.url, { waitUntil: "domcontentloaded", timeout: GOTO_TIMEOUT_MS });
    await page.waitForTimeout(SETTLE_MS);

    if (mode === "entire-page") {
      // Resize the viewport to the document scroll height so a single
      // non-fullPage screenshot captures the entire page at the
      // dimensions Domotion will be asked to render. (The capture script
      // reads geometry from the live layout, so the viewport size at
      // capture time IS the canvas size.)
      const rawHeight = await page.evaluate(() => Math.max(
        document.documentElement.scrollHeight,
        document.body?.scrollHeight ?? 0,
      ));
      canvasH = Math.min(FULL_PAGE_MAX_H, Math.max(viewport.height, rawHeight));
      await page.setViewportSize({ width: viewport.width, height: canvasH });
      // Brief settle after resize — sticky-nav recompute, sticky-cta
      // re-anchor, etc.
      await page.waitForTimeout(400);
      // Force lazy-loaded imagery: scroll to the bottom and back so any
      // IntersectionObserver-gated assets fetch before we screenshot.
      await page.evaluate(async (h) => {
        window.scrollTo(0, h);
        await new Promise((r) => setTimeout(r, 400));
        window.scrollTo(0, 0);
      }, canvasH);
      await page.waitForTimeout(800);
    } else if (mode === "scroll") {
      // For the scroll-animated SVG we capture the full document but
      // render the SVG inside a viewport-sized animated wrapper, so the
      // capture canvas matches the document height — same setup as
      // entire-page.
      const rawHeight = await page.evaluate(() => Math.max(
        document.documentElement.scrollHeight,
        document.body?.scrollHeight ?? 0,
      ));
      canvasH = Math.min(FULL_PAGE_MAX_H, Math.max(viewport.height, rawHeight));
      await page.setViewportSize({ width: viewport.width, height: canvasH });
      await page.waitForTimeout(400);
      await page.evaluate(async (h) => {
        window.scrollTo(0, h);
        await new Promise((r) => setTimeout(r, 400));
        window.scrollTo(0, 0);
      }, canvasH);
      await page.waitForTimeout(800);
    }

    // Expected PNG: for `fold` and `scroll` we screenshot the viewport-
    // sized fold (the scroll mode uses this as the t=0 reference). For
    // `entire-page` we screenshot the full document.
    const expectedClip = mode === "entire-page"
      ? { x: 0, y: 0, width: viewport.width, height: canvasH }
      : { x: 0, y: 0, width: viewport.width, height: viewport.height };
    await page.screenshot({ path: expectedPath, clip: expectedClip });

    // @font-face discovery: real sites near-universally use webfonts;
    // without this the SVG falls back to the chain default and looks
    // nothing like Chrome's paint.
    try { await discoverAndRegisterWebfonts(page); } catch { /* best-effort */ }

    const captureClip = { x: 0, y: 0, width: viewport.width, height: canvasH };
    const tree = await captureElementTree(page, "body", captureClip);
    warnings = getLastCaptureWarnings();
    const svgInner = elementTreeToSvg(tree, viewport.width, canvasH);
    const bodyBg = await page.evaluate(() => {
      const cs = getComputedStyle(document.body);
      const bg = cs.backgroundColor;
      if (bg === "rgba(0, 0, 0, 0)" || bg === "transparent") return "#ffffff";
      return bg;
    });

    // Build the SVG document. `scroll` mode wraps the captured content
    // inside a fixed-size animated viewport; the other modes emit the
    // captured tree at full canvas size.
    const svgDoc = mode === "scroll"
      ? buildScrollAnimatedSvg(svgInner, viewport.width, viewport.height, canvasH, bodyBg)
      : `<?xml version="1.0" encoding="UTF-8"?>`
        + `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewport.width} ${canvasH}" `
        + `width="${viewport.width}" height="${canvasH}">`
        + `<rect width="${viewport.width}" height="${canvasH}" fill="${bodyBg}" />`
        + `${svgInner}`
        + `</svg>`;
    writeFileSync(svgPath, svgDoc);

    // Render the SVG by loading it as a top-level document so file://
    // asset refs (if any) resolve. `scroll` mode renders inside the
    // viewport-sized wrapper, so the actual screenshot is the t=0 frame
    // of the animation — good enough for a reviewer to spot-check
    // top-of-page fidelity. The animation itself plays when the .svg
    // is opened from the review tool (link in each card).
    const actualClip = mode === "entire-page"
      ? { x: 0, y: 0, width: viewport.width, height: canvasH }
      : { x: 0, y: 0, width: viewport.width, height: viewport.height };
    await page.goto(`file://${svgPath}`);
    await page.waitForTimeout(300);
    await page.screenshot({ path: actualPath, clip: actualClip });
  } catch (e) {
    captureError = e instanceof Error ? e.message : String(e);
  } finally {
    await context.close();
  }

  if (captureError != null) {
    return makeErrorResult(test, site, viewport, mode, viewport.width, canvasH, captureError, warnings);
  }

  // Compare. Diff dimensions = the actual.png we just wrote.
  const diffH = mode === "entire-page" ? canvasH : viewport.height;
  await comparePage.setViewportSize({
    width: viewport.width * 2,
    height: Math.max(diffH, 800),
  });

  let cmp;
  try {
    cmp = await comparePngs(comparePage, expectedPath, actualPath, diffPath);
  } catch (e) {
    return makeErrorResult(
      test, site, viewport, mode, viewport.width, diffH,
      `compare failed: ${e instanceof Error ? e.message : String(e)}`,
      warnings,
    );
  }

  // Pass criterion: identical to the rest of the suites — every differing
  // pixel must be classified as glyph anti-aliasing. Real sites virtually
  // never hit that bar; the metric is informational on every mode.
  const pass = mode === "fold" && cmp.nonAaPixels === 0;

  return {
    name: test,
    site: site.name,
    viewport: viewport.name,
    mode,
    pass,
    diffPct: cmp.diffPct,
    sigPixelPct: cmp.sigPixelPct,
    worstTilePct: cmp.worstTilePct,
    worstTileSignificantPct: cmp.worstTileSignificantPct,
    nonAaPixels: cmp.nonAaPixels,
    nonAaPixelPct: cmp.nonAaPixelPct,
    width: viewport.width,
    height: diffH,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

function makeErrorResult(
  name: string, site: Site, viewport: Viewport, mode: Mode,
  width: number, height: number, error: string,
  warnings: Array<{ selector: string; feature: string; detail: string }>,
): Result {
  return {
    name, site: site.name, viewport: viewport.name, mode,
    pass: false,
    diffPct: 100, sigPixelPct: 100, worstTilePct: 100, worstTileSignificantPct: 100,
    nonAaPixels: 0, nonAaPixelPct: 100,
    width, height, error,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

/**
 * Wrap captured page content in a viewport-sized SVG that scrolls the
 * content over time via a CSS keyframe `translateY` animation. The result
 * is a fully self-contained animated SVG: open it in any browser and the
 * page scrolls from top to bottom and loops.
 *
 * Timing: 5% hold at the top, linear scroll for the next 90%, 5% hold at
 * the bottom — gives the eye time to land before motion starts and a
 * beat at the end before the loop restarts.
 */
function buildScrollAnimatedSvg(
  innerSvgContent: string,
  viewportWidth: number,
  viewportHeight: number,
  fullHeight: number,
  bg: string,
): string {
  const distance = Math.max(0, fullHeight - viewportHeight);
  const totalSec = SCROLL_ANIM_MS / 1000;
  // Use a unique class name so the keyframes don't collide if the SVG
  // ends up inlined alongside other Domotion-generated SVGs in a page.
  const animClass = `dm-scroll-${Math.random().toString(36).slice(2, 8)}`;
  return `<?xml version="1.0" encoding="UTF-8"?>`
    + `<svg xmlns="http://www.w3.org/2000/svg" `
    + `viewBox="0 0 ${viewportWidth} ${viewportHeight}" `
    + `width="${viewportWidth}" height="${viewportHeight}">`
    + `<defs>`
    +   `<clipPath id="${animClass}-clip">`
    +     `<rect width="${viewportWidth}" height="${viewportHeight}"/>`
    +   `</clipPath>`
    +   `<style>`
    +     `.${animClass} { animation: ${animClass} ${totalSec}s linear infinite; }`
    +     `@keyframes ${animClass} {`
    +       `0% { transform: translateY(0); }`
    +       `5% { transform: translateY(0); }`
    +       `95% { transform: translateY(-${distance}px); }`
    +       `100% { transform: translateY(-${distance}px); }`
    +     `}`
    +   `</style>`
    + `</defs>`
    + `<rect width="${viewportWidth}" height="${viewportHeight}" fill="${bg}"/>`
    + `<g clip-path="url(#${animClass}-clip)">`
    +   `<g class="${animClass}">`
    +     `<svg x="0" y="0" width="${viewportWidth}" height="${fullHeight}" viewBox="0 0 ${viewportWidth} ${fullHeight}">`
    +       `<rect width="${viewportWidth}" height="${fullHeight}" fill="${bg}"/>`
    +       `${innerSvgContent}`
    +     `</svg>`
    +   `</g>`
    + `</g>`
    + `</svg>`;
}

void main();
