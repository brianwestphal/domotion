/**
 * Visual check for the `system-font` render text mode (docs 261).
 *
 * For each fixture it:
 *   1. screenshots the source HTML in Chromium  → expected.png
 *   2. captures the tree and renders it in `system-font` mode → actual.svg
 *   3. rasterizes that SVG in a browser (using THIS machine's system fonts,
 *      the same faces Chromium painted with) → actual.png
 *   4. pixel-diffs expected vs actual → diff.png + a percentage
 *
 * Because `system-font` relies on the fonts being installed, a LOW diff on a
 * machine with the referenced fonts present is the success signal (unlike the
 * pixel-faithful modes, this makes no cross-machine guarantee). Outputs land in
 * `examples/system-font/output/` (gitignored).
 *
 * Run: `npx tsx examples/system-font/verify.ts`
 */
import { chromium } from "@playwright/test";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { captureElementTree, elementTreeToSvg } from "../../src/index.js";
import { comparePngs } from "../../src/review/compare-pngs.js";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "output");
mkdirSync(outDir, { recursive: true });

const fixtures = readdirSync(here)
  .filter((f) => f.endsWith(".html"))
  .sort();

const browser = await chromium.launch({ headless: true });
const source = await browser.newPage({ viewport: { width: 800, height: 900 } });
const raster = await browser.newPage({ viewport: { width: 800, height: 900 } });
const comparePage = await browser.newPage();

let worst = 0;
for (const file of fixtures) {
  const name = file.replace(/\.html$/, "");
  await source.goto(`file://${join(here, file)}`);
  await source.waitForLoadState("networkidle");

  const box = await source.evaluate(() => {
    const b = document.body.getBoundingClientRect();
    return { x: 0, y: 0, width: Math.ceil(b.width), height: Math.ceil(b.height) };
  });

  const expectedPath = join(outDir, `${name}.expected.png`);
  await source.screenshot({ path: expectedPath, clip: box });

  const tree = await captureElementTree(source, "body", box);
  const svg = elementTreeToSvg(tree, box.width, box.height, { renderTextMode: "system-font" });
  const svgPath = join(outDir, `${name}.system-font.svg`);
  writeFileSync(svgPath, svg);

  await raster.setViewportSize({ width: box.width, height: box.height });
  await raster.setContent(`<!doctype html><body style="margin:0">${svg}</body>`);
  await raster.waitForLoadState("networkidle");
  const actualPath = join(outDir, `${name}.actual.png`);
  await raster.screenshot({ path: actualPath, clip: { x: 0, y: 0, width: box.width, height: box.height } });

  const cmp = await comparePngs(comparePage, expectedPath, actualPath, join(outDir, `${name}.diff.png`));
  const embedded = elementTreeToSvg(tree, box.width, box.height, { renderTextMode: "embedded-font" });
  const ratio = ((svg.length / embedded.length) * 100).toFixed(0);
  worst = Math.max(worst, cmp.diffPct);
  console.log(
    `${name.padEnd(20)} diff ${cmp.diffPct.toFixed(3)}%  regions ${cmp.regionCount}` +
      `  size ${(svg.length / 1024).toFixed(1)}KB (${ratio}% of embedded)`,
  );
}

await browser.close();
console.log(`\nworst diff: ${worst.toFixed(3)}%  — outputs in examples/system-font/output/`);
