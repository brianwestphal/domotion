import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";
import sharp from "/Users/westphal/Documents/domotion/node_modules/sharp/lib/index.js";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 800 } });
const page = await ctx.newPage();
// Without font-palette
await page.setContent(`<html><body style="margin:0;padding:0;background:#fff"><div style="font-size:48px;font-family:'Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji',emoji;width:200px;height:80px">😀</div></body></html>`);
await page.waitForLoadState("networkidle");
const noPal = await page.evaluate(() => {
  const div = document.querySelector("div");
  const r = document.createRange();
  r.setStart(div.firstChild, 0); r.setEnd(div.firstChild, 2);
  const cr = r.getBoundingClientRect();
  return { x: cr.x, y: cr.y, w: cr.width, h: cr.height };
});
const buf1 = await page.screenshot({ clip: { x: 0, y: 0, width: 100, height: 80 } });
writeFileSync("/tmp/dm919-nopal.png", buf1);

// With font-palette
await page.setContent(`<html><body style="margin:0;padding:0;background:#fff">
<style>
@font-palette-values --pal {
  font-family: 'Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji',emoji;
  base-palette: 0;
}
</style>
<div style="font-size:48px;font-family:'Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji',emoji;font-palette:--pal;width:200px;height:80px">😀</div></body></html>`);
await page.waitForLoadState("networkidle");
const pal = await page.evaluate(() => {
  const div = document.querySelector("div");
  const r = document.createRange();
  r.setStart(div.firstChild, 0); r.setEnd(div.firstChild, 2);
  const cr = r.getBoundingClientRect();
  return { x: cr.x, y: cr.y, w: cr.width, h: cr.height };
});
const buf2 = await page.screenshot({ clip: { x: 0, y: 0, width: 100, height: 80 } });
writeFileSync("/tmp/dm919-pal.png", buf2);

async function findEdges(path) {
  const { data, info } = await sharp(path).raw().toBuffer({ resolveWithObject: true });
  let l = -1, r = -1;
  for (let x = 0; x < info.width; x++) {
    for (let y = 0; y < info.height; y++) {
      const i = (y * info.width + x) * info.channels;
      if (data[i] < 240 || data[i+1] < 240 || data[i+2] < 240) { l = x; break; }
    }
    if (l >= 0) break;
  }
  for (let x = info.width - 1; x >= 0; x--) {
    for (let y = 0; y < info.height; y++) {
      const i = (y * info.width + x) * info.channels;
      if (data[i] < 240 || data[i+1] < 240 || data[i+2] < 240) { r = x; break; }
    }
    if (r >= 0) break;
  }
  return { l, r };
}
const e1 = await findEdges("/tmp/dm919-nopal.png");
const e2 = await findEdges("/tmp/dm919-pal.png");
console.log("noPal: rect:", JSON.stringify(noPal), "painted:", e1, "width:", e1.r - e1.l + 1);
console.log("withPal: rect:", JSON.stringify(pal), "painted:", e2, "width:", e2.r - e2.l + 1);
await browser.close();
