import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 1280 } });
const page = await ctx.newPage({ baseURL: "http://localhost:0/" });
await page.goto("file://" + process.cwd() + "/external/html-test/17-deep-image-set.html");
await page.waitForLoadState("networkidle");
const out = await page.evaluate(() => {
  const el = document.querySelector(".with-gradient");
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  return {
    backgroundImage: cs.backgroundImage,
    backgroundSize: cs.backgroundSize,
    backgroundOrigin: cs.backgroundOrigin,
    backgroundRepeat: cs.backgroundRepeat,
    rect: { w: r.width, h: r.height },
  };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
