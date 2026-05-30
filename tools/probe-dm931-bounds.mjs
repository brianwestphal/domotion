import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 2000 } });
const page = await ctx.newPage();
await page.setContent(readFileSync("external/html-test/24-deep-initial-letter.html", "utf-8"));
await page.waitForLoadState("networkidle");
// Probe via a sentinel measuring the pseudo's painted bbox
const out = await page.evaluate(() => {
  const p = document.querySelector(".drop-fancy p:first-of-type");
  // Use getBoxQuads if available on the ::first-letter pseudo
  const ps = window.getComputedStyle(p, "::first-letter");
  // Pseudo has no DOM node — measure via the host paragraph's clientWidth +
  // do CSS computation from the rule
  // Get the FONT-SIZE
  return {
    flWidth: ps.width,
    flHeight: ps.height,
    flLineHeight: ps.lineHeight,
    flMarginLeft: ps.marginLeft,
    flMarginRight: ps.marginRight,
    flMarginTop: ps.marginTop,
    flMarginBottom: ps.marginBottom,
    flBorderBoxSize: ps.borderBoxSize,  // unlikely populated for pseudos
    flInitialLetter: ps.initialLetter,
    flWebkitInitialLetter: ps.webkitInitialLetter,
  };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
