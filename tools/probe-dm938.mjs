// What does Chrome's getComputedStyle return for font-variant-caps elements?
// And what does Range.getBoundingClientRect produce for each character?
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 1100 } });
const page = await ctx.newPage();
await page.setContent(readFileSync("external/html-test/20-deep-font-features.html", "utf-8"));
await page.waitForLoadState("networkidle");
const out = await page.evaluate(() => {
  const el = document.querySelector(".smcp");
  const cs = getComputedStyle(el);
  return {
    fontFamily: cs.fontFamily,
    fontSize: cs.fontSize,
    fontVariantCaps: cs.fontVariantCaps,
    fontVariantLigatures: cs.fontVariantLigatures,
    fontVariantNumeric: cs.fontVariantNumeric,
    fontFeatureSettings: cs.fontFeatureSettings,
    text: el.textContent,
    rect: { w: el.getBoundingClientRect().width },
  };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
