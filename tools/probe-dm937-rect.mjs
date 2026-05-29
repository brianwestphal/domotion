// Capture just the .drop label region from Chrome to see the actual paint.
import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 1200 } });
const page = await ctx.newPage();
await page.setContent(readFileSync("external/html-test/06-forms-style-file.html", "utf-8"));
await page.waitForLoadState("networkidle");
// Screenshot just the .drop region at 2x for clarity
const buf = await page.screenshot({ clip: { x: 25, y: 595, width: 200, height: 175 }, omitBackground: false });
writeFileSync("/tmp/dm937-chrome-corner.png", buf);
await browser.close();
