import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 2000 } });
const page = await ctx.newPage();
await page.setContent(readFileSync("external/html-test/24-deep-initial-letter.html", "utf-8"));
await page.waitForLoadState("networkidle");
// Take a wide screenshot of the .drop-fancy area
const r = await page.evaluate(() => {
  const p = document.querySelector(".drop-fancy p:first-of-type");
  const r = p.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
console.log("p rect:", r);
// Screenshot the WHOLE p element
const buf = await page.screenshot({ clip: { x: 0, y: r.y - 30, width: 300, height: r.h + 60 } });
writeFileSync("/tmp/dm931-full-chrome.png", buf);
console.log("wrote");
await browser.close();
