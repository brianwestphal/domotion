import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 2000 } });
const page = await ctx.newPage();
await page.setContent(readFileSync("external/html-test/24-deep-initial-letter.html", "utf-8"));
await page.waitForLoadState("networkidle");
// Capture EXACT same region as our elementRaster does
const buf = await page.screenshot({ 
  clip: { x: 26.3, y: 723.3, width: 103.2, height: 125.8 },
  omitBackground: true,
});
writeFileSync("/tmp/dm931-raster-capture.png", buf);
console.log("captured");
await browser.close();
