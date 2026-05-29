import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 2000 } });
const page = await ctx.newPage();
await page.setContent(readFileSync("external/html-test/20-deep-tab-size.html", "utf-8"));
await page.waitForLoadState("networkidle");
const info = await page.evaluate(() => {
  const tas = document.querySelectorAll('textarea');
  return Array.from(tas).map(ta => {
    const cs = getComputedStyle(ta);
    const r = ta.getBoundingClientRect();
    return {
      cls: ta.className,
      bl: cs.borderLeftWidth, bt: cs.borderTopWidth,
      pl: cs.paddingLeft, pt: cs.paddingTop, pb: cs.paddingBottom,
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
      scrollH: ta.scrollHeight,
      clientH: ta.clientHeight,
    };
  });
});
console.log(JSON.stringify(info.slice(0, 2), null, 2));
const r = info[0].rect;
const buf = await page.screenshot({ clip: { x: r.x, y: r.y, width: r.w, height: r.h }, omitBackground: false });
writeFileSync("/tmp/dm924-fresh-ta.png", buf);
await browser.close();
