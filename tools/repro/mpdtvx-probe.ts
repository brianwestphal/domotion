// DM-MPDTVX: does the native-control page's paint change between two screenshots
// with (arm "capture") or without (arm "idle") captureElementTreeWithWarnings in between?
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { captureElementTreeWithWarnings, launchChromium } from "../../src/index.js";
const src = readFileSync("tests/native-control-decoration.e2e.test.ts", "utf8");
const start = src.indexOf("await page.setContent(`<style>\n        html,body{margin:0;background:white;color-scheme");
const html = src.slice(src.indexOf("`", start) + 1, src.indexOf("`);", start));
const N = Number(process.argv[2] ?? 20);
const out = process.env.OUT ?? "mpdtvx-out";
mkdirSync(out, { recursive: true });
const browser = await launchChromium({ args: ["--enable-blink-features=AppearanceBase"] });
const viewport = { width: 940, height: 620 };
const stats = { capture: 0, idle: 0 };
for (let i = 0; i < N; i++) {
  for (const arm of ["capture", "idle"] as const) {
    const page = await browser.newPage({ viewport, deviceScaleFactor: 2 });
    await page.setContent(html);
    const before = await page.screenshot({ omitBackground: true });
    if (arm === "capture") await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, ...viewport });
    else await page.waitForTimeout(300);
    const after = await page.screenshot({ omitBackground: true });
    if (Buffer.compare(before, after) !== 0) {
      stats[arm]++;
      writeFileSync(`${out}/${arm}-${i}-before.png`, before);
      writeFileSync(`${out}/${arm}-${i}-after.png`, after);
    }
    await page.close();
  }
}
console.log(JSON.stringify({ N, differing: stats }));
await browser.close();
