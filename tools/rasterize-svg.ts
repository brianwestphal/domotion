// Rasterize an SVG via Playwright to compare to the test runner output
import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";

const SVG_PATH = process.argv[2];
const OUT_PATH = process.argv[3];
if (!SVG_PATH || !OUT_PATH) { console.error("usage: rasterize-svg.ts <input.svg> <output.png>"); process.exit(1); }

(async () => {
  const svg = readFileSync(SVG_PATH, "utf8");
  const m = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
  const w = m ? parseInt(m[1]) : 1280;
  const h = m ? parseInt(m[2]) : 6000;

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.setContent(`<!doctype html><html><body style="margin:0;background:#fff">${svg}</body></html>`);
  await page.waitForTimeout(500);
  await page.screenshot({ path: OUT_PATH, clip: { x: 0, y: 0, width: w, height: h } });
  console.log("wrote", OUT_PATH);
  await browser.close();
})();
