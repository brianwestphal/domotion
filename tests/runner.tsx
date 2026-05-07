/** @jsxRuntime automatic */
/** @jsxImportSource #jsx */

/**
 * Visual Regression Test Runner
 *
 * For each feature test:
 * 1. Renders HTML in Playwright -> PNG ("expected")
 * 2. Captures DOM -> SVG -> renders SVG in Playwright -> PNG ("actual")
 * 3. Compares pixel-by-pixel
 *
 * Usage: npx tsx tests/runner.tsx [--only feature-name]
 */

import { chromium, type BrowserContext, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { captureElementTree, elementTreeToSvg } from "../src/dom-to-svg.js";
import { raw } from "../src/jsx-runtime.js";
import { comparePngs, passes } from "./compare-pngs.js";
import { lowerProcessPriority, resolveWorkerCount, runJobsInPool } from "./worker-pool.js";

// Resolve against this script's dir so runs from any cwd write to the real
// tests/output, not a stray nested ... path.
const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = resolve(TESTS_DIR, "output");
const WIDTH = 400;
const HEIGHT = 300;

export interface FeatureTest {
  name: string;
  html: string;
  width?: number;
  height?: number;
}

/** Wrapper page used to render the test fixture HTML for the "expected" PNG. */
function FixturePage({ body }: { body: string }) {
  return (
    <html>
      <head>
        <meta charset="utf-8" />
        <style>{raw(`* { margin: 0; padding: 0; box-sizing: border-box; } body { background: #0d1117; overflow: hidden; }`)}</style>
      </head>
      <body>{raw(body)}</body>
    </html>
  );
}

/** Wrapper page that loads the generated SVG into an `<img>` for the "actual" PNG. */
function SvgRenderPage({ svgUrl, width, height }: { svgUrl: string; width: number; height: number }) {
  return (
    <html>
      <head>
        <meta charset="utf-8" />
        <style>{raw(`* { margin: 0; } body { overflow: hidden; }`)}</style>
      </head>
      <body>
        <img src={svgUrl} width={width} height={height} />
      </body>
    </html>
  );
}

function renderDoc(node: { toString(): string }): string {
  return `<!DOCTYPE html>${node.toString()}`;
}

export interface SuiteResult {
  name: string;
  nonAaPixels: number;
  nonAaPixelPct: number;
  diffPct: number;
  sigPixelPct: number;
  worstTilePct: number;
  worstTileSignificantPct: number;
  worstTileRect: { x: number; y: number; w: number; h: number };
  pass: boolean;
}

interface RunnerWorker {
  context: BrowserContext;
  page: Page;
  compareContext: BrowserContext;
  comparePage: Page;
}

async function runOneTest(test: FeatureTest, w: RunnerWorker): Promise<SuiteResult> {
  const width = test.width ?? WIDTH;
  const height = test.height ?? HEIGHT;
  const expectedPath = resolve(OUTPUT_DIR, `${test.name}-expected.png`);
  const actualPath = resolve(OUTPUT_DIR, `${test.name}-actual.png`);
  const diffPath = resolve(OUTPUT_DIR, `${test.name}-diff.png`);
  const htmlPath = resolve(OUTPUT_DIR, `${test.name}.html`);
  const svgPath = resolve(OUTPUT_DIR, `${test.name}.svg`);

  // Step 1: Render HTML -> PNG. DM-509: replaced the prior 100ms
  // waitForTimeout with document.fonts.ready — the wait existed to let
  // -apple-system / Inter / monospace fonts finish resolving before the
  // screenshot, but a fixed 100ms is both wasteful when fonts are cached
  // and racy when they aren't. document.fonts.ready resolves exactly when
  // every active FontFace has loaded.
  writeFileSync(htmlPath, renderDoc(<FixturePage body={test.html} />));
  await w.page.setViewportSize({ width, height });
  await w.page.goto(`file://${htmlPath}`);
  await w.page.evaluate(() => document.fonts.ready);
  await w.page.screenshot({ path: expectedPath, clip: { x: 0, y: 0, width, height } });

  // Step 2: Capture DOM -> SVG
  const tree = await captureElementTree(w.page, "body", { x: 0, y: 0, width, height });
  const svgContent = elementTreeToSvg(tree, width, height);
  const svgDoc = `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#0d1117" />${svgContent}</svg>`;
  writeFileSync(svgPath, svgDoc);

  // Step 3: Render SVG -> PNG. DM-509: setContent skips the file:// round-
  // trip (no extra HTML write, no goto re-parse) and waitUntil: 'load'
  // already includes the <img> resource load, so the prior 200ms wait is
  // redundant. Wait once more on document.fonts.ready in case the embedded
  // SVG carries text that triggers font resolution in this context too.
  const svgRenderHtml = renderDoc(<SvgRenderPage svgUrl={`file://${svgPath}`} width={width} height={height} />);
  await w.page.setContent(svgRenderHtml, { waitUntil: "load" });
  await w.page.evaluate(() => document.fonts.ready);
  await w.page.screenshot({ path: actualPath, clip: { x: 0, y: 0, width, height } });

  // Step 4: Compare. Pass criterion (DM-383): every differing pixel must be
  // classified as glyph anti-aliasing by the Yee detector. avg / sig / tile
  // metrics are diagnostic.
  const cmp = await comparePngs(w.comparePage, expectedPath, actualPath, diffPath);
  const pass = passes(cmp);

  return {
    name: test.name,
    nonAaPixels: cmp.nonAaPixels,
    nonAaPixelPct: cmp.nonAaPixelPct,
    diffPct: cmp.diffPct,
    sigPixelPct: cmp.sigPixelPct,
    worstTilePct: cmp.worstTilePct,
    worstTileSignificantPct: cmp.worstTileSignificantPct,
    worstTileRect: cmp.worstTileRect,
    pass,
  };
}

/**
 * Run a feature-style test suite. If `suiteName` is given, writes a per-suite
 * results manifest to `tests/output/<suiteName>-results.json` (used by the
 * review tool). Otherwise results are only printed. Returns the raw results
 * in case the caller wants to do extra post-processing.
 *
 * Jobs run in a bounded-concurrency worker pool (default `cpus - 1`
 * workers, overridable via `--workers N` or `DOMOTION_TEST_WORKERS`).
 * Leaving one core free keeps the host responsive (DM-459). Each worker
 * owns its own capture context+page and compare canvas page so the runs
 * don't serialize behind a single Playwright tab. DM-456.
 */
export async function runFeatureTests(tests: FeatureTest[], suiteName?: string): Promise<SuiteResult[]> {
  const args = process.argv.slice(2);
  const onlyTest = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;

  mkdirSync(OUTPUT_DIR, { recursive: true });

  const jobs = onlyTest != null ? tests.filter((t) => t.name === onlyTest) : tests;
  if (jobs.length === 0) {
    console.log(`No tests matched (--only ${onlyTest ?? "(none)"}).`);
    return [];
  }

  // DM-459: yield CPU to interactive work — Chromium subprocesses inherit.
  lowerProcessPriority();
  const browser = await chromium.launch();
  const workerCount = resolveWorkerCount();

  const results = await runJobsInPool<FeatureTest, RunnerWorker, SuiteResult>({
    jobs,
    workers: workerCount,
    setup: async () => {
      const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT } });
      const page = await context.newPage();
      // DM-479: 90 s instead of Playwright's 30 s default; covers slow
      // capture passes on heavier fixtures without paving over genuine hangs.
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
    runJob: async (test, w) => runOneTest(test, w),
    onResult: (r) => {
      const status = r.pass ? "✓ PASS" : "✗ FAIL";
      console.log(`  ${status}  ${r.name}  (non-AA ${r.nonAaPixels} px (${r.nonAaPixelPct.toFixed(3)}%) · avg ${r.diffPct.toFixed(2)}% · sig ${r.sigPixelPct.toFixed(1)}% · tile avg ${r.worstTilePct.toFixed(1)}% / sig ${r.worstTileSignificantPct.toFixed(1)}%)`);
    },
  });

  await browser.close();

  // Write a per-suite manifest the review tool (tests/review-server.tsx) reads
  // to render per-test cards. Include a timestamp so the review page shows
  // when the run happened without having to check filesystem dates. Written
  // regardless of pass/fail so the review tool can still be launched after a
  // failed run. Keyed by suiteName so running multiple suites doesn't clobber
  // earlier runs.
  if (suiteName != null) {
    writeFileSync(
      resolve(OUTPUT_DIR, `${suiteName}-results.json`),
      JSON.stringify({ suite: suiteName, generatedAt: new Date().toISOString(), results }, null, 2),
    );
  }

  // Summary
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${passed} passed, ${failed} failed out of ${results.length} tests`);

  if (failed > 0) {
    console.log("\nFailed tests — inspect diff images in:");
    for (const r of results.filter((r) => !r.pass)) {
      console.log(`  ${OUTPUT_DIR}/${r.name}-diff.png  non-AA ${r.nonAaPixels} px (${r.nonAaPixelPct.toFixed(3)}%)  avg ${r.diffPct.toFixed(2)}%  tile sig ${r.worstTileSignificantPct.toFixed(1)}%`);
    }
    console.log("\nReview tool: npx tsx tests/review-server.tsx");
    process.exit(1);
  }

  console.log("\nReview tool: npx tsx tests/review-server.tsx");
  return results;
}
