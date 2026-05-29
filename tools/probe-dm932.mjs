import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 1900 } });
const page = await ctx.newPage();
await page.setContent(readFileSync("external/html-test/20-deep-text-stroke.html", "utf-8"));
await page.waitForLoadState("networkidle");
const out = await page.evaluate(() => {
  const el = document.querySelectorAll(".display.ts3.po")[0];
  const cs = getComputedStyle(el);
  return {
    color: cs.color,
    strokeWidth: cs.webkitTextStrokeWidth,
    strokeColor: cs.webkitTextStrokeColor,
    paintOrder: cs.paintOrder,
  };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
