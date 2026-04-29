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

import { chromium, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { captureElementTree, elementTreeToSvg } from "../src/dom-to-svg.js";
import { raw } from "../src/jsx-runtime.js";

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

/** Compare two PNG buffers pixel-by-pixel. Returns difference percentage (0-100). */
async function comparePngs(page: Page, expectedPath: string, actualPath: string, diffPath: string): Promise<number> {
  const expectedB64 = readFileSync(expectedPath).toString("base64");
  const actualB64 = readFileSync(actualPath).toString("base64");

  const result = await page.evaluate(
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

      const canvas1 = document.createElement("canvas");
      canvas1.width = w; canvas1.height = h;
      const ctx1 = canvas1.getContext("2d");
      ctx1.drawImage(expected, 0, 0);
      const data1 = ctx1.getImageData(0, 0, w, h).data;

      const canvas2 = document.createElement("canvas");
      canvas2.width = w; canvas2.height = h;
      const ctx2 = canvas2.getContext("2d");
      ctx2.drawImage(actual, 0, 0);
      const data2 = ctx2.getImageData(0, 0, w, h).data;

      // Create diff image
      const diffCanvas = document.createElement("canvas");
      diffCanvas.width = w; diffCanvas.height = h;
      const diffCtx = diffCanvas.getContext("2d");
      const diffData = diffCtx.createImageData(w, h);

      // Euclidean color distance scoring: each pixel contributes its color distance
      // as a fraction of the maximum possible distance (sqrt(3) * 255 ≈ 441.67).
      // This gives a continuous 0-100% score where anti-aliasing differences (small
      // color shifts on many pixels) score much lower than structural differences
      // (large color shifts from misplaced elements).
      const maxDist = Math.sqrt(255 * 255 * 3); // ~441.67
      let totalDist = 0;
      const totalPixels = w * h;

      for (let i = 0; i < data1.length; i += 4) {
        const dr = data1[i] - data2[i];
        const dg = data1[i+1] - data2[i+1];
        const db = data1[i+2] - data2[i+2];
        const dist = Math.sqrt(dr * dr + dg * dg + db * db);
        const norm = dist / maxDist; // 0..1

        totalDist += norm;

        // Diff image: intensity = how different (red channel)
        const intensity = Math.min(255, dist * 2);
        if (intensity > 8) {
          diffData.data[i] = intensity;
          diffData.data[i+1] = 0;
          diffData.data[i+2] = 0;
          diffData.data[i+3] = 255;
        } else {
          // Show original dimmed
          diffData.data[i] = data1[i] * 0.3;
          diffData.data[i+1] = data1[i+1] * 0.3;
          diffData.data[i+2] = data1[i+2] * 0.3;
          diffData.data[i+3] = 255;
        }
      }

      diffCtx.putImageData(diffData, 0, 0);

      return {
        diffPercent: (totalDist / totalPixels) * 100,
        diffDataUrl: diffCanvas.toDataURL("image/png"),
      };
    })()`
  ) as { diffPercent: number; diffDataUrl: string };

  // Save diff image
  const diffBase64 = (result.diffDataUrl as string).split(",")[1];
  writeFileSync(diffPath, Buffer.from(diffBase64, "base64"));

  return result.diffPercent;
}

export interface SuiteResult { name: string; diffPct: number; pass: boolean }

/**
 * Run a feature-style test suite. If `suiteName` is given, writes a per-suite
 * results manifest to `tests/output/<suiteName>-results.json` (used by the
 * review tool). Otherwise results are only printed. Returns the raw results
 * in case the caller wants to do extra post-processing.
 */
export async function runFeatureTests(tests: FeatureTest[], suiteName?: string): Promise<SuiteResult[]> {
  const args = process.argv.slice(2);
  const onlyTest = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;

  mkdirSync(OUTPUT_DIR, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT } });
  const page = await context.newPage();

  // Comparison page (for PNG diff)
  const compareContext = await browser.newContext({ viewport: { width: WIDTH * 2, height: HEIGHT } });
  const comparePage = await compareContext.newPage();
  await comparePage.goto("about:blank");

  const results: Array<{ name: string; diffPct: number; pass: boolean }> = [];

  for (const test of tests) {
    if (onlyTest != null && test.name !== onlyTest) continue;

    const w = test.width ?? WIDTH;
    const h = test.height ?? HEIGHT;
    const expectedPath = resolve(OUTPUT_DIR, `${test.name}-expected.png`);
    const actualPath = resolve(OUTPUT_DIR, `${test.name}-actual.png`);
    const diffPath = resolve(OUTPUT_DIR, `${test.name}-diff.png`);
    const htmlPath = resolve(OUTPUT_DIR, `${test.name}.html`);
    const svgPath = resolve(OUTPUT_DIR, `${test.name}.svg`);

    // Step 1: Render HTML -> PNG
    writeFileSync(htmlPath, renderDoc(<FixturePage body={test.html} />));
    await page.setViewportSize({ width: w, height: h });
    await page.goto(`file://${htmlPath}`);
    await page.waitForTimeout(100);
    await page.screenshot({ path: expectedPath, clip: { x: 0, y: 0, width: w, height: h } });

    // Step 2: Capture DOM -> SVG
    const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: w, height: h });
    const svgContent = elementTreeToSvg(tree, w, h);
    const svgDoc = `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#0d1117" />${svgContent}</svg>`;
    writeFileSync(svgPath, svgDoc);

    // Step 3: Render SVG -> PNG
    const svgHtmlPath = resolve(OUTPUT_DIR, `${test.name}-svg-render.html`);
    writeFileSync(svgHtmlPath, renderDoc(<SvgRenderPage svgUrl={`file://${svgPath}`} width={w} height={h} />));
    await page.goto(`file://${svgHtmlPath}`);
    await page.waitForTimeout(200);
    await page.screenshot({ path: actualPath, clip: { x: 0, y: 0, width: w, height: h } });

    // Step 4: Compare
    const diffPct = await comparePngs(comparePage, expectedPath, actualPath, diffPath);
    const pass = diffPct < 3; // less than 3% color distance = pass

    results.push({ name: test.name, diffPct, pass });

    const status = pass ? "✓ PASS" : "✗ FAIL";
    console.log(`  ${status}  ${test.name}  (${diffPct.toFixed(2)}% diff)`);
  }

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
      console.log(`  ${OUTPUT_DIR}/${r.name}-diff.png (${r.diffPct.toFixed(2)}%)`);
    }
    console.log("\nReview tool: npx tsx tests/review-server.tsx");
    process.exit(1);
  }

  console.log("\nReview tool: npx tsx tests/review-server.tsx");
  return results;
}
