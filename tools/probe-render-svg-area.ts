/* eslint-disable */
// Render the actual stripe SVG output and screenshot only the label area.
import { chromium } from "@playwright/test";
import { resolve, dirname, readFileSync } from "node:fs";
async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 6000 }, isMobile: true, hasTouch: true });
  // Use the wrapper HTML the test renderer produces
  await page.goto("file://./tests/output/real-world/stripe-mobile-entire-page.wrapper.html");
  await page.waitForTimeout(500);
  await page.screenshot({ path: "/tmp/svg-card-row.png", clip: { x: 300, y: 1100, width: 90, height: 20 } });
  // Also screenshot a wider area
  await page.screenshot({ path: "/tmp/svg-row1.png", clip: { x: 260, y: 1100, width: 180, height: 30 } });
  await browser.close();
}
main();
