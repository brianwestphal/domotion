import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 2000 } });
const page = await ctx.newPage();
await page.setContent(readFileSync("external/html-test/24-deep-initial-letter.html", "utf-8"));
await page.waitForLoadState("networkidle");
const out = await page.evaluate(() => {
  const p = document.querySelector(".drop-fancy p:first-of-type");
  const r = p.getBoundingClientRect();
  const flCs = getComputedStyle(p, "::first-letter");
  // Probe the first letter via Range
  const tw = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
  const node = tw.nextNode();
  if (!node) return { error: "no text" };
  const rng = document.createRange();
  rng.setStart(node, 0); rng.setEnd(node, 1);
  const cr = rng.getBoundingClientRect();
  return {
    pRect: { x: r.x, y: r.y, w: r.width, h: r.height },
    firstChar: { x: cr.x, y: cr.y, w: cr.width, h: cr.height },
    flFontSize: flCs.fontSize,
    flFontWeight: flCs.fontWeight,
    flFontFamily: flCs.fontFamily,
    flPadding: flCs.padding,
    flBackground: flCs.background?.slice(0, 80),
    flBorderRadius: flCs.borderRadius,
    flMargin: flCs.margin,
  };
});
console.log(JSON.stringify(out, null, 2));
// Screenshot the actual painted region
if (out.pRect) {
  const buf = await page.screenshot({ clip: { x: out.pRect.x - 5, y: out.pRect.y - 5, width: 200, height: 200 } });
  writeFileSync("/tmp/dm931-b-chrome.png", buf);
}
await browser.close();
