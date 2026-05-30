import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 1500 } });
const page = await ctx.newPage();
await page.setContent(readFileSync("external/html-test/20-deep-text-underline-position.html", "utf-8"));
await page.waitForLoadState("networkidle");
// First .vert.pos-left
const info = await page.evaluate(() => {
  const el = document.querySelector(".vert.pos-left");
  const ulSpan = el.querySelector(".ul");
  const r = el.getBoundingClientRect();
  const ur = ulSpan.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const ulCs = getComputedStyle(ulSpan);
  return {
    elRect: { x: r.x, y: r.y, w: r.width, h: r.height },
    ulRect: { x: ur.x, y: ur.y, w: ur.width, h: ur.height },
    elPad: { l: cs.paddingLeft, t: cs.paddingTop },
    elBorder: { l: cs.borderLeftWidth, t: cs.borderTopWidth },
    ulDeco: ulCs.textDecorationThickness,
    ulPos: ulCs.textUnderlinePosition,
  };
});
console.log(JSON.stringify(info, null, 2));
// Screenshot the .vert area with margin to see the underline
const buf = await page.screenshot({ clip: { x: info.ulRect.x - 10, y: info.ulRect.y - 5, width: info.ulRect.w + 20, height: info.ulRect.h + 10 } });
writeFileSync("/tmp/dm957-chrome.png", buf);
await browser.close();
