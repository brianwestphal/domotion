import { chromium } from "@playwright/test";
import { resolve } from "node:path";

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  const page = await ctx.newPage();
  await page.goto("file://" + resolve("external/html-test/17-deep-image-set.html"));
  await page.waitForTimeout(300);
  const out = await page.evaluate(() => {
    const r: any[] = [];
    for (const el of document.querySelectorAll(".tile")) {
      const cs = getComputedStyle(el);
      r.push({ cls: (el as HTMLElement).className, bgImage: cs.backgroundImage });
    }
    return r;
  });
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
})();
