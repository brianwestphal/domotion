import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 800 } });
const page = await ctx.newPage();
await page.setContent(readFileSync("external/html-test/10-sel-pseudo-elements.html", "utf-8"));
await page.waitForLoadState("networkidle");
const out = await page.evaluate(() => {
  const el = document.querySelector(".drop");
  const cs = getComputedStyle(el);
  const flCs = getComputedStyle(el, "::first-line");
  return {
    elFontVariantCaps: cs.fontVariantCaps,
    elLetterSpacing: cs.letterSpacing,
    flFontVariantCaps: flCs.fontVariantCaps,
    flLetterSpacing: flCs.letterSpacing,
    flFontVariant: flCs.fontVariant,
  };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
