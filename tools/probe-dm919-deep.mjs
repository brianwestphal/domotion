import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 800 } });
const page = await ctx.newPage();
// Simple test page — single 48px emoji
await page.setContent(`<html><body style="margin:0;padding:0"><div style="font-size:48px;font-family:Apple Color Emoji,emoji;width:100px;height:100px;background:#eee">😀</div></body></html>`);
await page.waitForLoadState("networkidle");
const out = await page.evaluate(() => {
  const div = document.querySelector("div");
  const node = div.firstChild;
  const r = document.createRange();
  r.setStart(node, 0);
  r.setEnd(node, 2);
  const cr = r.getBoundingClientRect();
  return { x: cr.x, y: cr.y, w: cr.width, h: cr.height };
});
console.log("Range rect:", JSON.stringify(out));
const buf = await page.screenshot({ clip: { x: 0, y: 0, width: 100, height: 100 } });
writeFileSync("/tmp/dm919-deep.png", buf);
// Pixel-scan for leftmost non-white pixel
import sharp from "/Users/westphal/Documents/domotion/node_modules/sharp/lib/index.js";
const { data, info } = await sharp("/tmp/dm919-deep.png").raw().toBuffer({ resolveWithObject: true });
let leftEdge = -1;
for (let x = 0; x < info.width; x++) {
  for (let y = 0; y < info.height; y++) {
    const i = (y * info.width + x) * info.channels;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    // Skip near-white background (#eee = 238)
    if (r < 200 || g < 200 || b < 200) {
      leftEdge = x;
      break;
    }
  }
  if (leftEdge >= 0) break;
}
let rightEdge = -1;
for (let x = info.width - 1; x >= 0; x--) {
  for (let y = 0; y < info.height; y++) {
    const i = (y * info.width + x) * info.channels;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (r < 200 || g < 200 || b < 200) {
      rightEdge = x;
      break;
    }
  }
  if (rightEdge >= 0) break;
}
console.log("Painted emoji leftmost px:", leftEdge, "rightmost px:", rightEdge, "width:", rightEdge - leftEdge + 1);
await browser.close();
