import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 2000 } });
const page = await ctx.newPage();
await page.setContent(readFileSync("external/html-test/24-deep-initial-letter.html", "utf-8"));
await page.waitForLoadState("networkidle");

// Use Range over the first character to get its rect — but ::first-letter
// pseudo paint area extends beyond the char rect.
const info = await page.evaluate(() => {
  const p = document.querySelector(".drop-fancy p:first-of-type");
  const text = p.firstChild;
  // First character
  const range = document.createRange();
  range.setStart(text, 0);
  range.setEnd(text, 1);
  const r = range.getBoundingClientRect();
  const rects = [...range.getClientRects()].map(rr => ({x:rr.x,y:rr.y,w:rr.width,h:rr.height}));
  // Computed pseudo styles
  const ps = window.getComputedStyle(p, "::first-letter");
  return {
    rangeRect: { x: r.x, y: r.y, w: r.width, h: r.height },
    rangeRects: rects,
    padding: ps.padding,
    borderRadius: ps.borderRadius,
    margin: `${ps.marginTop} ${ps.marginRight} ${ps.marginBottom} ${ps.marginLeft}`,
    background: ps.backgroundImage,
    width: ps.width,
    height: ps.height,
    fontSize: ps.fontSize,
  };
});
console.log(JSON.stringify(info, null, 2));

// Also screenshot a WIDER region than our captured raster to see how far
// the paint extends
const buf = await page.screenshot({ clip: { x: 0, y: 700, width: 250, height: 200 } });
writeFileSync("/tmp/dm931-wide.png", buf);
await browser.close();
