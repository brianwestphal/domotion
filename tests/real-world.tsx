/** @jsxRuntime automatic */
/** @jsxImportSource kerfjs */

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

import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { captureElementTreeWithWarnings, elementTreeToSvg, embedRemoteImages } from "../src/dom-to-svg.js";
import { resizeEmbeddedImages } from "../src/resize-embedded-images.js";
import { rasterizeConicGradients } from "../src/conic-raster.js";
import { discoverAndRegisterWebfonts } from "../src/capture.js";
import { parseScrollPattern } from "../src/scroll/pattern.js";
import { executeScrollPattern } from "../src/scroll/executor.js";
import { composeScrollSvg } from "../src/scroll/composer.js";
import { cullFrame } from "../src/viewbox-culling.js";
import { comparePngs } from "./compare-pngs.js";
import { lowerProcessPriority, resolveWorkerCount, runJobsInPool } from "./worker-pool.js";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = resolve(TESTS_DIR, "output/real-world");
// Persistent HTTP-Archive (HAR) cache. First run for a (site × viewport)
// records every network request to disk; subsequent runs replay from the
// HAR so the suite doesn't keep hammering real production sites. Wipe a
// HAR (or the whole dir) to force a re-fetch.
const CACHE_DIR = resolve(TESTS_DIR, "cache/real-world");

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

// Per-page Playwright operation timeout. DM-479: standardized at 90 s
// (was a mix of 25 s / 30 s defaults / 60 s explicit). Real-world fixtures
// pull tens of MB of CSS / fonts / images from third-party CDNs, and the
// shorter timeouts were causing flaky failures on slow runs without
// providing meaningful protection against genuinely-stuck pages.
const PLAYWRIGHT_TIMEOUT_MS = 90_000;
const GOTO_TIMEOUT_MS = PLAYWRIGHT_TIMEOUT_MS;

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

interface RealWorldWorker {
  comparePage: Page;
  compareContext: BrowserContext;
}

async function main(): Promise<void> {
  // DM-459: yield CPU to interactive work — Chromium subprocesses inherit.
  lowerProcessPriority();
  const args = process.argv.slice(2);
  const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
  // DM-542: opt-in resize pre-pass for size-vs-fidelity validation.
  const enableResize = args.includes("--resize");
  const hiDPIArg = args.indexOf("--hi-dpi") >= 0 ? parseFloat(args[args.indexOf("--hi-dpi") + 1]) : NaN;
  const resizeHiDPI = Number.isFinite(hiDPIArg) ? hiDPIArg : 2;
  if (enableResize) {
    console.log(`[DM-542] resizeEmbeddedImages: ON (hiDPIFactor=${resizeHiDPI})`);
  }

  mkdirSync(OUTPUT_DIR, { recursive: true });
  mkdirSync(CACHE_DIR, { recursive: true });

  const allJobs = buildJobs();
  const jobs = only != null ? allJobs.filter((j) => j.test.startsWith(only)) : allJobs;
  if (jobs.length === 0) {
    console.log(`No jobs matched (only=${only ?? "(none)"}).`);
    return;
  }

  const browser = await chromium.launch();

  // First-time HAR recording can't run concurrently for the same (site,
  // viewport) — `routeFromHAR({ update: true })` writes the .har file, and
  // two contexts hammering the same path corrupt it. Pre-record any
  // missing HARs serially before opening the worker pool, then every
  // pooled job is a pure replay (concurrent-safe). DM-454 / DM-456.
  await ensureHarsRecorded(browser, jobs);

  const workerCount = resolveWorkerCount();
  console.log(`Running ${jobs.length} real-world capture jobs (${VIEWPORTS.length} viewports × ${MODES.length} modes × ${SITES.length} sites) with ${workerCount} workers...\n`);

  const newResults = await runJobsInPool<PageJob, RealWorldWorker, Result>({
    jobs,
    workers: workerCount,
    setup: async () => {
      const compareContext = await browser.newContext({
        viewport: { width: 1280 * 2, height: 800 },
      });
      const comparePage = await compareContext.newPage();
      await comparePage.goto("about:blank");
      return { compareContext, comparePage };
    },
    teardown: async (w) => { await w.compareContext.close(); },
    runJob: async (job, w) => runJob(browser, w.comparePage, job, { resize: enableResize, hiDPI: resizeHiDPI }),
    onResult: (result, job) => {
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
    },
  });

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

/**
 * For every (site, viewport) referenced by `jobs`, make sure the HAR cache
 * file exists on disk. Missing HARs are recorded serially with one context
 * per site — concurrent record-mode writes to the same .har file would
 * corrupt it (DM-454). After this returns every job in the pool can open
 * its context in pure-replay mode safely in parallel.
 *
 * Records by visiting the site at the larger of the (site, viewport)'s
 * desktop / mobile heights and scrolling end-to-end so lazy-loaded assets
 * are captured once. The pool's per-job goto then replays from the HAR.
 */
async function ensureHarsRecorded(browser: Browser, jobs: PageJob[]): Promise<void> {
  const missing = new Map<string, { site: Site; viewport: Viewport; harPath: string }>();
  for (const job of jobs) {
    const harPath = resolve(CACHE_DIR, `${job.site.name}-${job.viewport.name}.har`);
    if (existsSync(harPath)) continue;
    const key = `${job.site.name}|${job.viewport.name}`;
    if (missing.has(key)) continue;
    missing.set(key, { site: job.site, viewport: job.viewport, harPath });
  }
  if (missing.size === 0) return;

  console.log(`Recording ${missing.size} missing HAR file(s) before opening pool...`);
  for (const { site, viewport, harPath } of missing.values()) {
    const t0 = Date.now();
    process.stdout.write(`  recording ${site.name}-${viewport.name}.har ...`);
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: 1,
      isMobile: viewport.isMobile,
      hasTouch: viewport.isMobile,
      colorScheme: "light",
      userAgent: viewport.isMobile
        ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"
        : "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    });
    await context.routeFromHAR(harPath, { url: "**/*", update: true, notFound: "fallback" });
    const page = await context.newPage();
    // DM-479: standardize per-page Playwright operation timeouts at 90 s.
    page.setDefaultTimeout(PLAYWRIGHT_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(PLAYWRIGHT_TIMEOUT_MS);
    try {
      await page.goto(site.url, { waitUntil: "domcontentloaded", timeout: GOTO_TIMEOUT_MS });
      await page.waitForTimeout(SETTLE_MS);
      // Stretch to full document height + scroll end-to-end so the
      // entire-page / scroll modes find their lazy-loaded assets in the
      // HAR on the next pass.
      const rawHeight = await page.evaluate(() => Math.max(
        document.documentElement.scrollHeight,
        document.body?.scrollHeight ?? 0,
      ));
      const fullH = Math.min(FULL_PAGE_MAX_H, Math.max(viewport.height, rawHeight));
      await page.setViewportSize({ width: viewport.width, height: fullH });
      await page.waitForTimeout(400);
      await page.evaluate(async (h) => {
        window.scrollTo(0, h);
        await new Promise((r) => setTimeout(r, 400));
        window.scrollTo(0, 0);
      }, fullH);
      await page.waitForTimeout(800);
    } catch (e) {
      console.log(` failed: ${e instanceof Error ? e.message : String(e)}`);
      // Even on failure, close() flushes whatever was captured so the next
      // run replays partial responses rather than re-fetching from scratch.
    } finally {
      await context.close();
    }
    console.log(` ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
  console.log("");
}

async function runJob(
  browser: Browser,
  comparePage: Page,
  job: PageJob,
  resizeOpts: { resize: boolean; hiDPI: number } = { resize: false, hiDPI: 2 },
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
    // DM-555: previously this context forced `colorScheme: 'light'` because
    // Domotion couldn't emit a dark-mode SVG and would have repainted every
    // dark-rendering marketing page with light defaults — producing a
    // near-100% sig-pixel diff dominated by inversion, not capture fidelity.
    // Slices DM-552 / DM-553 / DM-554 have wired the dark-mode pipeline
    // (capture-side scheme propagation, dark form-control palette,
    // transparent-root fallback consuming `rootBgComputed`), so the suite
    // can now drop the force. Playwright's default `colorScheme` for a
    // newly-created context is `'light'` on all platforms (verified at
    // playwright.dev/docs/api/class-browser#browser-new-context-option-color-scheme),
    // so removing the explicit option keeps today's deterministic light
    // baseline AND lets a future caller pass `colorScheme: 'dark'` to
    // exercise the new dark pipeline without further plumbing changes.
    // A current-ish desktop / mobile UA so sites don't redirect us to a
    // legacy page. (Headless Chromium's default UA confuses some servers
    // into serving cut-down templates.)
    userAgent: viewport.isMobile
      ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"
      : "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  });

  // HAR cache: keyed by (site, viewport) since responses can vary by UA /
  // device. First run records, subsequent runs replay. `notFound: 'fallback'`
  // lets a record-mode run fetch newly-required assets through to the network;
  // replay-mode runs fall through to the network for anything not in the HAR
  // (which generally means the page made a new request that didn't exist
  // before — rare). To force a fresh capture, delete the HAR file.
  const harPath = resolve(CACHE_DIR, `${site.name}-${viewport.name}.har`);
  const harExists = existsSync(harPath);
  await context.routeFromHAR(harPath, {
    url: "**/*",
    update: !harExists,
    notFound: "fallback",
  });

  const page = await context.newPage();
  // DM-479: standardize per-page Playwright operation timeouts at 90 s.
  page.setDefaultTimeout(PLAYWRIGHT_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(PLAYWRIGHT_TIMEOUT_MS);

  // DM-513: track every font URL the page fetches so cross-origin webfonts
  // (e.g. Slashdot's sdicon.woff on a.fsdn.com) are discoverable. Without
  // this, page-side `performance.getEntriesByType("resource")` only sees
  // same-origin entries (cross-origin entries are gated by the third-party
  // server's `Timing-Allow-Origin` header) and `discoverAndRegisterWebfonts`
  // misses them entirely. The listener fires for every fetched resource;
  // we filter to font-shaped URLs.
  const fontUrls = new Set<string>();
  page.on("requestfinished", (req) => {
    const url = req.url();
    if (/\.(woff2?|ttf|otf)(\?|$)/i.test(url)) {
      fontUrls.add(url);
    }
  });

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
      // DM-471: third-party iframe ads (Slashdot footer, etc.) often start
      // loading only after the parent scrolls past their slot, and the
      // 800 ms post-scroll settle wasn't enough for the network round-trip
      // + iframe layout to finish before rasterizeReplacedElements ran —
      // resulting in 0×0 / empty snapshots and missing ad regions in the
      // actual SVG. Bumping to 1800 ms covers most ad-load latencies on
      // the recorded HARs without materially slowing the suite (one extra
      // second per entire-page / scroll capture).
      await page.waitForTimeout(1800);
    } else if (mode === "scroll") {
      // DM-613: scroll mode now uses the new multi-capture pipeline
      // (executor + composer). The viewport stays at `viewport.height`
      // (each segment is captured at viewport size), so `canvasH` keeps its
      // default. We still do a pre-scroll-to-bottom-then-top to wake
      // lazy-loaded content; the executor's own prescroll is disabled
      // below since we've already done it here.
      await page.evaluate(async () => {
        const h = Math.max(
          document.documentElement.scrollHeight,
          document.body?.scrollHeight ?? 0,
        );
        window.scrollTo(0, h);
        await new Promise((r) => setTimeout(r, 400));
        window.scrollTo(0, 0);
      });
      // Same 1800 ms iframe-ad settle as the entire-page mode.
      await page.waitForTimeout(1800);
    }

    // DM-461: @font-face discovery happens BEFORE the expected screenshot
    // so the expected and the capture see the same DOM moment. When this
    // ran BETWEEN the two reads, several seconds of webfont fetch / parse
    // let the page mutate further (carousels rotated, lazy images inserted,
    // sticky CTAs re-anchored, ads loaded), which made the captured tree
    // describe a different snapshot than the expected.png reference.
    // Observed as 41.70% diff on `nytimes-mobile-entire-page`; reordering
    // alone drops that to ~6%. We considered also pausing JS via CDP
    // `Emulation.setScriptExecutionDisabled` between the two reads to
    // close the remaining gap, but on at least one site (resend.com,
    // mobile fold) that crashed the page-side WebGL/canvas during the
    // subsequent rasterize pass — fragile, not worth the marginal
    // 0.5-1pp diff improvement. Order alone is the robust fix.
    try { await discoverAndRegisterWebfonts(page, fontUrls); } catch { /* best-effort */ }

    // DM-510 / DM-556: freeze the DOM so the Chromium reference screenshot
    // and Domotion's captureElementTree see the SAME state. Without this,
    // sites that JS-inject content after a delay (NYT paywall popup,
    // intersection-observer-driven loaders, sticky-CTA re-anchors) produce
    // expected.png and actual.svg from different DOM snapshots — the
    // reference shows the modal, the capture doesn't, and the diff is
    // dominated by timing race rather than rendering fidelity.
    //
    // The earlier comment block (DM-461) ruled out `Emulation.setScript-
    // ExecutionDisabled` because it crashed resend.com's WebGL/canvas
    // during rasterize. Same constraint here:
    //
    // - `window.stop()` would close the NYT paywall race (timer-injected
    //   modal that appears between screenshot and capture) — empirically
    //   takes nytimes-mobile-fold from 36.96% to 1.44% — but it ALSO
    //   breaks Stripe-mobile-scroll's renderer pipeline (subsequent
    //   `Page.captureScreenshot` fails with `Unable to capture`).
    // - `requestAnimationFrame` cancellation / no-op breaks sites with
    //   active WebGL render loops (same Stripe-mobile-scroll symptom).
    //
    // DM-556: in addition to the conservative timer + Web-Animations freeze,
    // no-op `window.fetch` and `XMLHttpRequest.prototype.send`. This catches
    // the NYT-paywall class of races — timer- or network-completion-driven
    // modals that DOM-inject AFTER the freeze step but BEFORE the screenshot
    // — without halting the renderer pipeline (`window.stop()` does that,
    // breaking Stripe's WebGL loop). Same-origin pre-fetched bytes already
    // sitting in Chromium's network stack still resolve normally; only NEW
    // network requests are silenced. Stripe's render loop doesn't fetch so
    // it's unaffected; NYT's paywall script is loaded via fetch after page
    // load and is silenced here.
    try {
      await page.evaluate(() => {
        try {
          if (typeof document.getAnimations === "function") {
            for (const a of document.getAnimations()) {
              try { a.pause(); } catch { /* */ }
            }
          }
        } catch { /* */ }
        // Cancel pending setTimeout handles (probe next handle, then iterate).
        try {
          const probe = window.setTimeout(() => {}, 0) as unknown as number;
          window.clearTimeout(probe);
          for (let i = 1; i <= probe; i++) {
            try { window.clearTimeout(i); } catch { /* */ }
            try { window.clearInterval(i); } catch { /* */ }
          }
        } catch { /* */ }
        // No-op future setTimeout / setInterval. Don't touch rAF.
        try {
          const noop = (() => 0) as any;
          window.setTimeout = noop;
          window.setInterval = noop;
        } catch { /* */ }
        // DM-556: no-op fetch / XHR.send so async-loaded modals can't inject
        // DOM between the freeze and the screenshot. Returns a never-resolving
        // promise so callers that `await` the fetch hang harmlessly (the page
        // is going to be screenshotted within milliseconds anyway).
        try {
          window.fetch = (() => new Promise(() => {})) as typeof window.fetch;
        } catch { /* */ }
        try {
          XMLHttpRequest.prototype.send = function() { /* no-op */ };
        } catch { /* */ }
        // DM-556: hide modal dialogs that were already injected during the
        // settle window (e.g. NYT mobile paywall). These appear in the
        // expected screenshot but not in the captured tree because they're
        // network-fetched and DOM-injected at unpredictable timing, leaving
        // the captured tree describing a different snapshot than expected.
        // Removing them produces a deterministic 'no modal' state on both
        // sides. Heuristic: `[role=dialog][aria-modal=true]` is the web
        // standard for accessibility-flagged modals.
        try {
          for (const el of document.querySelectorAll('[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]')) {
            try { (el as HTMLElement).style.display = "none"; } catch { /* */ }
          }
        } catch { /* */ }
      });
    } catch { /* best-effort */ }

    // Expected PNG: for `fold` and `scroll` we screenshot the viewport-
    // sized fold (the scroll mode uses this as the t=0 reference). For
    // `entire-page` we screenshot the full document.
    const expectedClip = mode === "entire-page"
      ? { x: 0, y: 0, width: viewport.width, height: canvasH }
      : { x: 0, y: 0, width: viewport.width, height: viewport.height };
    await page.screenshot({ path: expectedPath, clip: expectedClip });

    const captureClip = { x: 0, y: 0, width: viewport.width, height: canvasH };
    // captureElementTreeWithWarnings returns warnings inline so concurrent
    // workers don't race on the lastCaptureWarnings module global (DM-456).
    // DM-562: for `fold` and `entire-page` modes the expected.png already
    // covers the same coordinate space as captureClip, so crop replaced-
    // element rasters from that PNG instead of taking fresh per-rid
    // screenshots — eliminates the timing drift between the expected and
    // rotating cross-origin-iframe content (NYT Google Ads, etc.). For
    // `scroll` mode the expected.png is only the viewport-sized t=0 fold,
    // so we fall back to per-rid screenshots there.
    const rasterizeFromImagePath = (mode === "fold" || mode === "entire-page") ? expectedPath : undefined;
    const cap = await captureElementTreeWithWarnings(page, "body", captureClip, { rasterizeFromImagePath });
    warnings = cap.warnings;
    // DM-512: real-world captures of public sites reference image URLs on
    // the host CDN. Inline them as data: URIs so the produced SVGs load in
    // Preview / QuickLook / chat-client previewers (which don't fetch
    // remote resources from local files). DM-527: per-URL fetch failures
    // are appended to the same `warnings` array we collected from capture
    // so concurrent workers don't race on the lastCaptureWarnings global.
    await embedRemoteImages(cap.tree, { warnings });
    if (resizeOpts.resize) {
      await resizeEmbeddedImages(cap.tree, { hiDPIFactor: resizeOpts.hiDPI });
    }
    // DM-549: rasterize conic-gradient layers (no-op when tree has none).
    await rasterizeConicGradients(cap.tree, { hiDPIFactor: resizeOpts.hiDPI });
    const svgInner = elementTreeToSvg(cap.tree, viewport.width, canvasH, "", true, resizeOpts.hiDPI);
    // DM-554: when document.body is transparent, prefer the captured tree's
    // `rootBgComputed` (Chromium-resolved `<html>` bg, which handles author-
    // set roots AND the UA default per scheme — `#ffffff` for light,
    // `rgb(28, 28, 28)`-ish for dark). Falls back to a scheme-aware
    // hardcoded default when the captured tree predates DM-552 and lacks
    // the field. The pre-DM-554 hardcoded `#ffffff` was scheme-blind, which
    // produced a near-100% sig-pixel diff on every dark-rendered marketing
    // page (paint dark, repaint light → invert).
    const bodyBgFromPage = await page.evaluate(() => {
      const cs = getComputedStyle(document.body);
      const bg = cs.backgroundColor;
      if (bg === "rgba(0, 0, 0, 0)" || bg === "transparent") return null;
      return bg;
    });
    const rootStyles = cap.tree[0]?.styles;
    const rootBg = rootStyles?.rootBgComputed;
    const rootScheme = rootStyles?.rootColorScheme;
    const transparentRootBg = (rootBg != null && rootBg !== "rgba(0, 0, 0, 0)" && rootBg !== "transparent")
      ? rootBg
      : (rootScheme === "dark" ? "#1c1c1c" : "#ffffff");
    const bodyBg = bodyBgFromPage ?? transparentRootBg;

    // Build the SVG document. `scroll` mode (DM-613) now uses the new
    // multi-capture executor + composer pipeline: it runs the scroll
    // pattern against the live page, captures+diffs per segment, applies
    // the same post-processing per segment (embed remote images, resize,
    // rasterize conic gradients, viewBox-cull), and composes into one
    // animated SVG. The other modes emit the single captured tree at full
    // canvas size.
    let svgDoc: string;
    if (mode === "scroll") {
      // Pattern: scroll down to bottom over SCROLL_ANIM_MS. The 5%-hold-at-top
      // / 90%-scroll / 5%-hold-at-bottom timing from the old bespoke wrapper
      // isn't directly expressible in the v1 grammar; the composer's linear
      // keyframes through the segment-end percentages give a clean linear
      // scroll. We can refine pacing once profiling shows it matters.
      const scrollSec = SCROLL_ANIM_MS / 1000;
      const pattern = parseScrollPattern(`down:bottom/${scrollSec}s`);
      const segments = await executeScrollPattern(page, pattern, {
        viewportW: viewport.width,
        viewportH: viewport.height,
        // We already did the pre-scroll wake-up above; don't repeat it.
        prescroll: false,
      });
      // Per-segment post-processing: every tree needs the same passes the
      // single-capture path runs above (embed images, optional resize,
      // conic-gradient rasterise, viewBox cull). embedRemoteImages uses a
      // shared cache across calls, so repeated invocations on overlapping
      // image sets are cheap.
      for (const seg of segments) {
        await embedRemoteImages(seg.tree, { warnings });
        if (resizeOpts.resize) {
          await resizeEmbeddedImages(seg.tree, { hiDPIFactor: resizeOpts.hiDPI });
        }
        await rasterizeConicGradients(seg.tree, { hiDPIFactor: resizeOpts.hiDPI });
        cullFrame(seg.tree, viewport.width, viewport.height, undefined, 0, 1);
      }
      svgDoc = composeScrollSvg(segments, {
        viewportW: viewport.width,
        viewportH: viewport.height,
        bgColor: bodyBg,
        hiDPIFactor: resizeOpts.hiDPI,
      });
    } else {
      svgDoc = `<?xml version="1.0" encoding="UTF-8"?>`
        + `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewport.width} ${canvasH}" `
        + `width="${viewport.width}" height="${canvasH}">`
        + `<rect width="${viewport.width}" height="${canvasH}" fill="${bodyBg}" />`
        + `${svgInner}`
        + `</svg>`;
    }
    writeFileSync(svgPath, svgDoc);

    // Render the SVG via an HTML wrapper rather than navigating directly
    // to the .svg file. On mobile contexts (`isMobile: true`), Chromium
    // treats a standalone SVG as a non-responsive document and applies
    // mobile layout scaling (default 980 px virtual viewport), squashing
    // the SVG into the top-left quadrant of the screenshot. The HTML
    // wrapper carries an explicit `<meta viewport>` so the page lays out
    // at our device-pixel dimensions and the embedded SVG renders 1:1.
    // `scroll` mode renders inside the viewport-sized wrapper, so the
    // actual screenshot is the t=0 frame of the animation — good enough
    // for a reviewer to spot-check top-of-page fidelity. The animation
    // itself plays when the .svg is opened from the review tool.
    const actualClip = mode === "entire-page"
      ? { x: 0, y: 0, width: viewport.width, height: canvasH }
      : { x: 0, y: 0, width: viewport.width, height: viewport.height };
    const wrapperHtml = `<!doctype html><html><head>`
      + `<meta charset="utf-8">`
      + `<meta name="viewport" content="width=${viewport.width}, initial-scale=1, maximum-scale=1, user-scalable=no">`
      + `<style>html,body{margin:0;padding:0;background:${bodyBg};}svg{display:block;}</style>`
      + `</head><body>${svgDoc.replace(/^<\?xml[^?]*\?>/, "")}</body></html>`;
    const wrapperPath = svgPath.replace(/\.svg$/, ".wrapper.html");
    writeFileSync(wrapperPath, wrapperHtml);
    // DM-518: rendering the SVG wrapper on the same context that did the
    // production-site capture (routeFromHAR active, etc.) empirically
    // produces actuals where some glyph paths render as background-coloured
    // no-ops — even though the SVG renders correctly in librsvg and in a
    // fresh isolated Chromium load of the same wrapper. Bypass that
    // residual state by using a fresh disposable context just for the
    // wrapper render. The HAR is irrelevant to the wrapper (file:// URL
    // with inline SVG, no network).
    const renderContext = await browser.newContext({
      viewport: { width: viewport.width, height: canvasH },
      deviceScaleFactor: 1,
      isMobile: viewport.isMobile,
      hasTouch: viewport.isMobile,
    });
    const renderPage = await renderContext.newPage();
    renderPage.setDefaultTimeout(PLAYWRIGHT_TIMEOUT_MS);
    renderPage.setDefaultNavigationTimeout(PLAYWRIGHT_TIMEOUT_MS);
    await renderPage.goto(`file://${wrapperPath}`);
    await renderPage.waitForTimeout(300);
    // DM-481: always pass `animations: "disabled"` so scroll/cross-fade
    // SVGs are screenshotted at frame 0 (the resting state Chromium also
    // captures for the expected). Without this, ~0.5–1 s elapses between
    // page.goto and the screenshot, and a 12-second scroll animation has
    // already advanced ~80 px — that's why the Stripe nav bar appeared
    // missing in the actual (DM-481).
    // DM-475: heavy real-world fixtures (Stripe etc.) have triggered an
    // intermittent `page.screenshot` timeout ("waiting for fonts to
    // load... fonts loaded"). The retry with `animations: "disabled"`
    // was originally only on the failure path; now both attempts share
    // it. The retry kept here mainly for the rare case where the first
    // call hits a transient timeout.
    try {
      await renderPage.screenshot({ path: actualPath, clip: actualClip, timeout: PLAYWRIGHT_TIMEOUT_MS, animations: "disabled" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`  ${test}: screenshot failed (${msg.split("\n")[0]}); retrying`);
      await renderPage.screenshot({ path: actualPath, clip: actualClip, timeout: PLAYWRIGHT_TIMEOUT_MS, animations: "disabled" });
    }
    try { await renderContext.close(); } catch { /* best-effort */ }
    // Wrapper is purely a render harness — the .svg file is the artifact
    // reviewers/consumers care about.
    try { unlinkSync(wrapperPath); } catch { /* best-effort */ }
  } catch (e) {
    captureError = e instanceof Error ? e.message : String(e);
  } finally {
    // Defensive: a failed page.screenshot can leave the underlying
    // Chromium target in a half-closed state (DM-460), so the implicit
    // session teardown throws "Target page, context or browser has been
    // closed". Swallow that — the worker pool's onResult/onError logic
    // is what we want to surface, not a teardown error that masks the
    // real captureError.
    try { await context.close(); } catch { /* best-effort */ }
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

void main();
