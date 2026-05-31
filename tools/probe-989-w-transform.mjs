// Inspect Chrome's actual rendering of the drop-5 W: pseudo transform, effective bbox, and screenshot.
import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 1184 } });
const page = await ctx.newPage();
await page.setContent(readFileSync("external/html-test/24-deep-initial-letter.html", "utf-8"));
await page.waitForLoadState("networkidle");

const data = await page.evaluate(() => {
  const p = document.querySelector(".drop-5 p:first-of-type");
  const cs = getComputedStyle(p);
  const fl = getComputedStyle(p, "::first-letter");
  const firstNode = Array.from(p.childNodes).find((n) => n.nodeType === Node.TEXT_NODE);
  const raw = firstNode.textContent;
  const offset = raw.length - raw.replace(/^\s+/, "").length;
  const r = document.createRange();
  r.setStart(firstNode, offset);
  r.setEnd(firstNode, offset + 1);
  const cr = r.getBoundingClientRect();
  return {
    paragraphText: raw.slice(offset, offset + 20),
    rangeW: { x: +cr.x.toFixed(2), y: +cr.y.toFixed(2), w: +cr.width.toFixed(2), h: +cr.height.toFixed(2) },
    pseudoFontSize: fl.fontSize,
    pseudoFontFamily: fl.fontFamily,
    pseudoFontWeight: fl.fontWeight,
    pseudoFontStretch: fl.fontStretch,
    pseudoLineHeight: fl.lineHeight,
    pseudoInitialLetter: fl.initialLetter || fl.webkitInitialLetter,
    pseudoTransform: fl.transform,
    pseudoFloat: fl.float || fl.cssFloat,
    pseudoWidth: fl.width,
    pseudoHeight: fl.height,
    pseudoPadding: `${fl.paddingTop} ${fl.paddingRight} ${fl.paddingBottom} ${fl.paddingLeft}`,
  };
});

console.log(JSON.stringify(data, null, 2));

// Now screenshot just the W region for visual comparison.
const buf = await page.screenshot({ clip: { x: 30, y: 420, width: 250, height: 145 } });
writeFileSync("/tmp/probe-w-actual.png", buf);
console.log("screenshot saved to /tmp/probe-w-actual.png");
await browser.close();
