/**
 * DM-458: snapshot-isolation inspection test for replaced-element rasterization
 * (DM-457). Verifies that pseudo-element overlays painted on top of a
 * `<canvas>`'s screen rect do NOT bleed into the canvas's embedded snapshot,
 * independent of whether the SVG renderer paints those pseudos in the final
 * output.
 *
 * Approach: capture a fixture with a solid-blue canvas plus a sibling
 * element whose `::after { content:""; position:absolute; background: lime; }`
 * paints over half the canvas. Pull the canvas's `replacedSnapshot.dataUri`
 * out of the captured tree, decode the PNG via a Playwright canvas, and
 * assert that no pixel in the snapshot is green-dominated. Compares against
 * regular `comparePngs`-style fixtures because the SVG renderer doesn't
 * synthesize decorative pseudo-bg today, so a pixel-diff comparison would
 * fail for an unrelated reason — this test bypasses the renderer and asserts
 * the property of interest directly.
 *
 * Usage: npx tsx tests/snapshot-isolation.tsx
 */

import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { captureElementTreeWithWarnings } from "../src/render/element-tree-to-svg.js";
import type { CapturedElement } from "../src/capture/types.js";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = resolve(TESTS_DIR, "output");

const FIXTURE_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #0d1117; }
    .pol::after {
      content: "";
      position: absolute;
      left: 100px;
      top: 20px;
      width: 100px;
      height: 60px;
      background: rgb(0, 255, 0);
    }
  </style>
</head>
<body>
  <div style="padding:20px;position:relative;">
    <canvas id="c" width="200" height="100" style="display:block;background:#888;"></canvas>
    <div class="pol" style="position:absolute;left:0;top:0;width:1px;height:1px;"></div>
  </div>
  <script>
    var ctx = document.getElementById('c').getContext('2d');
    ctx.fillStyle = '#1f6feb';
    ctx.fillRect(0, 0, 200, 100);
  </script>
</body>
</html>`;

function findCanvasElement(els: CapturedElement[]): CapturedElement | null {
  for (const el of els) {
    if (el.tag === "canvas" && el.replacedSnapshot != null) return el;
    const inChild = findCanvasElement(el.children);
    if (inChild != null) return inChild;
  }
  return null;
}

async function main(): Promise<void> {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const fixturePath = resolve(OUTPUT_DIR, "snapshot-isolation-fixture.html");
  writeFileSync(fixturePath, FIXTURE_HTML);

  const browser = await chromium.launch();
  let failed = 0;
  try {
    const context = await browser.newContext({ viewport: { width: 400, height: 200 } });
    const page = await context.newPage();
    // DM-479: 90 s instead of Playwright's 30 s default.
    page.setDefaultTimeout(90_000);
    page.setDefaultNavigationTimeout(90_000);
    await page.goto(`file://${fixturePath}`);
    await page.waitForTimeout(100);

    const { tree } = await captureElementTreeWithWarnings(page, "body", {
      x: 0, y: 0, width: 400, height: 200,
    });

    const canvas = findCanvasElement(tree);
    if (canvas == null) {
      console.error("FAIL: no <canvas> element with replacedSnapshot found in captured tree");
      failed++;
    } else {
      const snap = canvas.replacedSnapshot!;
      if (snap.dataUri == null) {
        console.error("FAIL: canvas was captured but rasterizeReplacedElements left dataUri unset");
        failed++;
      } else {
        // Decode via a clean Playwright canvas: load the data URI into an
        // <img>, draw onto a 2d canvas, scan getImageData for green pixels.
        await page.setContent(
          `<html><body style="margin:0">
            <img id="snap" src="${snap.dataUri}" style="display:none" />
            <canvas id="dec" width="${Math.ceil(snap.width)}" height="${Math.ceil(snap.height)}"></canvas>
          </body></html>`,
        );
        await page.evaluate(() => new Promise<void>((res) => {
          const img = document.getElementById("snap") as HTMLImageElement;
          if (img.complete && img.naturalWidth > 0) res();
          else img.addEventListener("load", () => res(), { once: true });
        }));
        const greenStats = await page.evaluate(() => {
          const img = document.getElementById("snap") as HTMLImageElement;
          const cv = document.getElementById("dec") as HTMLCanvasElement;
          const ctx = cv.getContext("2d")!;
          ctx.drawImage(img, 0, 0);
          const data = ctx.getImageData(0, 0, cv.width, cv.height).data;
          let greenDominated = 0;
          let total = 0;
          for (let i = 0; i < data.length; i += 4) {
            const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
            if (a < 16) continue;
            total++;
            // "Green-dominated" = G clearly higher than both R and B. The
            // overlay is rgb(0, 255, 0); any bleed would push G well above
            // R/B in those pixels. Threshold of 60 channels keeps subtle
            // anti-aliasing from triggering; canvas fill is rgb(31,111,235)
            // (blue-dominated) so non-bleed pixels are nowhere near.
            if (g > r + 60 && g > b + 60) greenDominated++;
          }
          return { greenDominated, total };
        });

        // Save the snapshot out for inspection if it failed.
        const snapBytes = Buffer.from(snap.dataUri.replace(/^data:image\/png;base64,/, ""), "base64");
        writeFileSync(resolve(OUTPUT_DIR, "snapshot-isolation-canvas.png"), snapBytes);

        if (greenStats.greenDominated > 0) {
          console.error(
            `FAIL: snapshot contains ${greenStats.greenDominated} green-dominated pixels out of ${greenStats.total} ` +
              `— pseudo overlay leaked into the canvas snapshot. ` +
              `See ${resolve(OUTPUT_DIR, "snapshot-isolation-canvas.png")}.`,
          );
          failed++;
        } else {
          console.log(
            `✓ PASS  snapshot-isolation-pseudo-overlay  (${greenStats.total} opaque pixels scanned, 0 green-dominated)`,
          );
        }
      }
    }
    await context.close();
  } finally {
    await browser.close();
  }

  if (failed > 0) {
    console.error(`\n${failed} test(s) failed.`);
    process.exit(1);
  }
}

void main();
