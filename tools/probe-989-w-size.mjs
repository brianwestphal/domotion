// Verify what effective font-size matches Chrome's painted W in the drop-5 fixture.
import { chromium } from "@playwright/test";

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 1184 } });
const page = await ctx.newPage();
await page.setContent(`<!doctype html><html><head><style>
  .test { font-family: Georgia, serif; font-weight: 800; display:inline-block; }
</style></head><body>
  <span class="test" style="font-size: 102px">W</span>
  <span class="test" style="font-size: 152px">W</span>
  <span class="test" style="font-size: 200px">W</span>
  <span class="test" style="font-size: 207px">W</span>
</body></html>`);
await page.waitForLoadState("networkidle");
const widths = await page.evaluate(() => {
  return Array.from(document.querySelectorAll(".test")).map((el) => ({
    fontSize: el.style.fontSize,
    rect: el.getBoundingClientRect(),
    range: (() => {
      const r = document.createRange();
      r.selectNodeContents(el);
      const cr = r.getBoundingClientRect();
      return { x: +cr.x.toFixed(2), y: +cr.y.toFixed(2), w: +cr.width.toFixed(2), h: +cr.height.toFixed(2) };
    })(),
  }));
});
console.log(JSON.stringify(widths, null, 2));
await browser.close();
