// Probe Chrome's actual painted pixels for an emoji glyph (DM-381).
// Renders 02-text-entities.html in Playwright Chromium at DPR=1, screenshots,
// then uses an in-browser canvas to decode and find the painted bbox of the
// 😀 character — the actual top/left/right/bottom of any non-near-white pixel.

import { chromium } from "@playwright/test";
import path from "node:path";

const url = "file://" + path.resolve("external/html-test/") + "/02-text-entities.html";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
await page.goto(url);

const cellRect = await page.evaluate(() => {
  const td = document.evaluate("//td[contains(., '\u{1F600}')]", document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
  if (td == null) return null;
  const range = document.createRange();
  const text = td.firstChild;
  range.setStart(text, 0);
  range.setEnd(text, 2);
  const r = range.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height, fontSize: getComputedStyle(td).fontSize };
});
console.log("captured rect:", cellRect);

const png = await page.screenshot({ type: "png", clip: { x: cellRect.x - 10, y: cellRect.y - 10, width: cellRect.w + 20, height: cellRect.h + 20 } });
const b64 = png.toString("base64");

const bbox = await page.evaluate(async ({ b64, padX, padY }) => {
  const img = new Image();
  img.src = "data:image/png;base64," + b64;
  await new Promise((res) => { img.onload = res; });
  const c = document.createElement("canvas");
  c.width = img.width; c.height = img.height;
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, c.width, c.height).data;
  let minX = c.width, minY = c.height, maxX = 0, maxY = 0;
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      const i = (y * c.width + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (r < 240 || g < 240 || b < 240) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { localX: minX, localY: minY, w: maxX - minX + 1, h: maxY - minY + 1, padX, padY };
}, { b64, padX: cellRect.x - 10, padY: cellRect.y - 10 });

console.log("painted bbox in crop (local):", { x: bbox.localX, y: bbox.localY, w: bbox.w, h: bbox.h });
console.log("painted bbox absolute:", { x: bbox.padX + bbox.localX, y: bbox.padY + bbox.localY, w: bbox.w, h: bbox.h });

await browser.close();
