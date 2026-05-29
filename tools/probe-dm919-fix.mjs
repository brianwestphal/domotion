import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import sharp from "/Users/westphal/Documents/domotion/node_modules/sharp/lib/index.js";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 1200 } });
const page = await ctx.newPage();
await page.setContent(readFileSync("external/html-test/20-deep-font-palette.html", "utf-8"));
await page.waitForLoadState("networkidle");
// Get the smiley emoji's Range rect
const r = await page.evaluate(() => {
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = tw.nextNode())) if (node.textContent.includes("😀")) break;
  const idx = node.textContent.indexOf("😀");
  const rng = document.createRange();
  rng.setStart(node, idx); rng.setEnd(node, idx + 2);
  const cr = rng.getBoundingClientRect();
  return { x: cr.x, y: cr.y, w: cr.width, h: cr.height };
});
console.log("Range rect:", JSON.stringify(r));
// Screenshot a region around the emoji
const buf = await page.screenshot({ clip: { x: r.x - 20, y: r.y - 5, width: r.w + 40, height: r.h + 10 } });
writeFileSync("/tmp/dm919-region.png", buf);
const { data, info } = await sharp("/tmp/dm919-region.png").raw().toBuffer({ resolveWithObject: true });
// Find leftmost colored (non-bg) pixel
let leftEdge = -1, rightEdge = -1;
for (let x = 0; x < info.width; x++) {
  for (let y = 0; y < info.height; y++) {
    const i = (y * info.width + x) * info.channels;
    const r0 = data[i], g = data[i + 1], b = data[i + 2];
    // Background appears to be light bluish — skip near-white/light
    if (r0 < 240 || g < 240 || b < 240) {
      leftEdge = x;
      break;
    }
  }
  if (leftEdge >= 0) break;
}
for (let x = info.width - 1; x >= 0; x--) {
  for (let y = 0; y < info.height; y++) {
    const i = (y * info.width + x) * info.channels;
    const r0 = data[i], g = data[i + 1], b = data[i + 2];
    if (r0 < 240 || g < 240 || b < 240) {
      rightEdge = x;
      break;
    }
  }
  if (rightEdge >= 0) break;
}
// Convert back to viewport coords (clip started at r.x - 20)
console.log("Painted emoji viewport-x range:", leftEdge + (r.x - 20), "to", rightEdge + (r.x - 20));
console.log("Range.x:", r.x, "rect spans to:", r.x + r.w);
console.log("Emoji width:", rightEdge - leftEdge + 1);
console.log("Emoji left edge relative to range.x:", leftEdge + (r.x - 20) - r.x);
await browser.close();
