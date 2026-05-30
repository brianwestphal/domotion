import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import sharp from "sharp";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 2000 } });
const page = await ctx.newPage();
await page.setContent(readFileSync("external/html-test/24-deep-initial-letter.html", "utf-8"));
await page.waitForLoadState("networkidle");
const buf = await page.screenshot({ clip: { x: 26.3, y: 723.3, width: 103.2, height: 125.8 } });
writeFileSync("/tmp/dm931-chrome-same-region.png", buf);
await sharp({ create: { width: 320, height: 200, channels: 3, background: { r: 255, g: 255, b: 255 } } })
  .composite([
    { input: "/tmp/dm931-B-raster.png", left: 10, top: 20 },
    { input: "/tmp/dm931-chrome-same-region.png", left: 180, top: 20 },
  ])
  .toFile("/tmp/dm931-sbs.png");
await browser.close();
console.log("done");
