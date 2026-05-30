import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 2000 } });
const page = await ctx.newPage();
await page.setContent(readFileSync("external/html-test/24-deep-initial-letter.html", "utf-8"));
await page.waitForLoadState("networkidle");
const out = await page.evaluate(() => {
  const p = document.querySelector(".drop-3 p:first-of-type");
  const flCs = getComputedStyle(p, "::first-letter");
  return {
    fontSize: flCs.fontSize,
    fontWeight: flCs.fontWeight,
    color: flCs.color,
    fontFamily: flCs.fontFamily,
  };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
