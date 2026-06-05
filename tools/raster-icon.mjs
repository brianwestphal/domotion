import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
const svg = readFileSync("tests/output/real-world/resend-mobile-entire-page.svg", "utf8");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 6000 } });
await page.setContent(`<!doctype html><html><body style="margin:0">${svg}</body></html>`);
// Full icon column region: x 40..110, y 3620..4420
const buf = await page.screenshot({ clip: { x: 40, y: 3620, width: 120, height: 800 } });
writeFileSync("tests/output/raster-icon-column.png", buf);
console.log("wrote raster-icon-column.png");
await browser.close();
