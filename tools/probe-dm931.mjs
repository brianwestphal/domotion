import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 1200 } });
const page = await ctx.newPage();
await page.setContent(readFileSync("external/html-test/24-deep-initial-letter.html", "utf-8"));
await page.waitForLoadState("networkidle");
const out = await page.evaluate(() => {
  const p = document.querySelector(".drop-fancy p:first-of-type");
  const flStyle = window.getComputedStyle(p, "::first-letter");
  return {
    fontSize: flStyle.fontSize,
    background: flStyle.background,
    backgroundImage: flStyle.backgroundImage,
    padding: flStyle.padding,
    borderRadius: flStyle.borderRadius,
  };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
