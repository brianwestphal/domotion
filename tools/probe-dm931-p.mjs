import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 2000 } });
const page = await ctx.newPage();
await page.setContent(readFileSync("external/html-test/24-deep-initial-letter.html", "utf-8"));
await page.waitForLoadState("networkidle");
const info = await page.evaluate(() => {
  const p = document.querySelector(".drop-fancy p:first-of-type");
  const cs = getComputedStyle(p);
  return {
    pPad: { t: cs.paddingTop, l: cs.paddingLeft, r: cs.paddingRight, b: cs.paddingBottom },
    pBorder: { t: cs.borderTopWidth, l: cs.borderLeftWidth },
    pMargin: { t: cs.marginTop, l: cs.marginLeft },
    flFloat: getComputedStyle(p, '::first-letter').float,
    flCssFloat: getComputedStyle(p, '::first-letter').cssFloat,
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
