import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 800 } });
const page = await ctx.newPage();
await page.setContent(readFileSync("external/html-test/20-deep-text-emphasis.html", "utf-8"));
await page.waitForLoadState("networkidle");
const out = await page.evaluate(() => {
  const ems = document.querySelectorAll('em');
  return Array.from(ems).slice(0, 8).map(el => {
    const cs = getComputedStyle(el);
    return {
      cls: el.className,
      style: cs.textEmphasisStyle,
      color: cs.textEmphasisColor,
      position: cs.textEmphasisPosition,
      fontSize: cs.fontSize,
      text: el.textContent?.slice(0, 30),
    };
  });
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
