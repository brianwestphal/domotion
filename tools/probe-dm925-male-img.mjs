import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } });
const page = await ctx.newPage();
const tests = [
  ["sans-serif", "/tmp/dm925-male-sans.png"],
  ["Hiragino Sans GB, sans-serif", "/tmp/dm925-male-hiraginogb.png"],
  ["Apple Symbols", "/tmp/dm925-male-apple.png"],
  ["AppleSDGothicNeo", "/tmp/dm925-male-korean.png"],
];
for (const [family, path] of tests) {
  await page.setContent(`<html><body style="margin:0"><span style="font-family:'${family}';font-size:40px">♂</span></body></html>`);
  await page.waitForLoadState("networkidle");
  const buf = await page.screenshot({ clip: { x: 0, y: 0, width: 60, height: 60 } });
  writeFileSync(path, buf);
}
await browser.close();
