import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 1500 } });
const page = await ctx.newPage();
await page.setContent(readFileSync("external/html-test/20-deep-text-underline-position.html", "utf-8"));
await page.waitForLoadState("networkidle");
// Find a .vert.pos-left content rect
const info = await page.evaluate(() => {
  const lefts = document.querySelectorAll(".vert.pos-left, .vert.pos-right, .vert.pos-auto");
  return Array.from(lefts).map((el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const ul = el.querySelector(".ul");
    const ur = ul ? ul.getBoundingClientRect() : null;
    return {
      cls: el.className,
      writingMode: cs.writingMode,
      textUnderlinePosition: cs.textUnderlinePosition,
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
      ulRect: ur ? { x: ur.x, y: ur.y, w: ur.width, h: ur.height } : null,
    };
  });
});
console.log(JSON.stringify(info, null, 2));
// Screenshot the first .vert content area
const er = info[0];
const buf = await page.screenshot({ clip: { x: er.rect.x - 5, y: er.rect.y - 5, width: er.rect.w + 10, height: er.rect.h + 10 } });
writeFileSync("/tmp/dm936-vert-left.png", buf);
const buf2 = await page.screenshot({ clip: { x: info[1].rect.x - 5, y: info[1].rect.y - 5, width: info[1].rect.w + 10, height: info[1].rect.h + 10 } });
writeFileSync("/tmp/dm936-vert-right.png", buf2);
await browser.close();
