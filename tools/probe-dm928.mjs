import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 1200 } });
const page = await ctx.newPage();
await page.setContent(readFileSync("external/html-test/32-real-world-pricing-table.html", "utf-8"));
await page.waitForLoadState("networkidle");
const out = await page.evaluate(() => {
  const li = document.querySelector(".features li:not(.no)");
  const beforeStyle = getComputedStyle(li, "::before");
  return {
    content: beforeStyle.content,
    width: beforeStyle.width,
    height: beforeStyle.height,
    borderRight: beforeStyle.borderRight,
    borderBottom: beforeStyle.borderBottom,
    borderTop: beforeStyle.borderTop,
    borderLeft: beforeStyle.borderLeft,
    transform: beforeStyle.transform,
    transformOrigin: beforeStyle.transformOrigin,
    position: beforeStyle.position,
    left: beforeStyle.left,
    top: beforeStyle.top,
  };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
