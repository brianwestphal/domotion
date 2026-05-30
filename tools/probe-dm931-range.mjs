import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 2000 } });
const page = await ctx.newPage();
await page.setContent(readFileSync("external/html-test/24-deep-initial-letter.html", "utf-8"));
await page.waitForLoadState("networkidle");
const info = await page.evaluate(() => {
  const p = document.querySelector(".drop-fancy p:first-of-type");
  const text = p.firstChild;
  const range = document.createRange();
  range.setStart(text, 0);
  range.setEnd(text, 1);
  const r = range.getBoundingClientRect();
  // Use elementsFromPoint to identify what's there
  const samples = [];
  for (const [x, y] of [[32, 774], [50, 800], [110, 880], [32, 882]]) {
    const els = document.elementsFromPoint(x, y);
    samples.push({ x, y, els: els.slice(0, 3).map(e => e.tagName + (e.className ? "." + e.className : "")) });
  }
  // Get the OFFSET of the floated ::first-letter via getBoxQuads
  let boxQuads = null;
  if ((p).getBoxQuads) {
    try {
      const quads = (p).getBoxQuads({ box: "border" });
      boxQuads = quads.map(q => q.getBounds()).map(b => ({x:b.x,y:b.y,w:b.width,h:b.height}));
    } catch(e) { boxQuads = "err:" + e.message; }
  }
  return {
    pRect: { x: p.getBoundingClientRect().x, y: p.getBoundingClientRect().y, w: p.getBoundingClientRect().width, h: p.getBoundingClientRect().height },
    firstCharRange: { x: r.x, y: r.y, w: r.width, h: r.height },
    samples,
    boxQuads,
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
