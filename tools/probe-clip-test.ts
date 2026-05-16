/* eslint-disable */
import { chromium } from "@playwright/test";
async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 500, height: 50 } });
  await page.goto("file:///tmp/test-clip.html");
  await page.waitForTimeout(200);
  await page.screenshot({ path: "/tmp/clip-test.png" });
  await browser.close();
}
main();
