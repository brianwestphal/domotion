import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import sharp from "sharp";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 1392 } });
const page = await ctx.newPage();
await page.setContent(readFileSync("external/html-test/32-real-world-pricing-table.html", "utf-8"));
await page.waitForLoadState("networkidle");

// Find one features li, get its rect + the ::before rect
const info = await page.evaluate(() => {
  const lis = Array.from(document.querySelectorAll(".features li")).slice(0, 5).map((li, i) => {
    const r = li.getBoundingClientRect();
    const bs = window.getComputedStyle(li, "::before");
    return {
      i,
      text: li.textContent?.trim().substring(0, 40),
      liRect: { x: r.x, y: r.y, w: r.width, h: r.height },
      beforeWidth: bs.width,
      beforeHeight: bs.height,
      beforeLeft: bs.left,
      beforeTop: bs.top,
      beforeTransform: bs.transform,
      beforeBorderRight: bs.borderRight,
      beforeBorderBottom: bs.borderBottom,
      hasNoClass: li.classList.contains("no"),
    };
  });
  return lis;
});
console.log(JSON.stringify(info, null, 2));

// Screenshot one li 5x zoom
const li0 = info[0];
const screenshot = await page.screenshot({ clip: { x: li0.liRect.x - 4, y: li0.liRect.y - 2, width: li0.liRect.w + 8, height: li0.liRect.h + 4 } });
writeFileSync("/tmp/p928-li-chrome.png", screenshot);
const m = await sharp("/tmp/p928-li-chrome.png").metadata();
await sharp("/tmp/p928-li-chrome.png").resize(m.width*5, m.height*5, { kernel: "nearest" }).toFile("/tmp/p928-li-chrome-z.png");
await browser.close();
