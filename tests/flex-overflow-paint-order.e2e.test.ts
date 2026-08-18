import { afterAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { captureElementTree, elementTreeToSvg, launchChromium } from "../src/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

const HTML = `<!doctype html><style>
body{margin:0;font:700 18px/24px Arial,sans-serif}
.flex{display:flex;flex-direction:column;width:120px;height:80px;background:#eee}
.item{flex:none;width:120px;aspect-ratio:1/2;background:#2453d4;color:white}
.later{width:220px;height:40px;color:#111}
</style><div class="flex"><div class="item">early flex item</div></div><div class="later">later flow text</div>`;

const env = await (async () => {
  try { return { browser: await launchChromium() }; } catch { return null; }
})();
afterAll(async () => { await closeBrowserSafely(env?.browser); }, 15_000);
const describeBrowser = env ? describe : describe.skip;

describeBrowser("overflowing flex-item paint order", () => {
  it("paints later flow text above the earlier overflowing item (DM-2286)", async () => {
    const context = await env!.browser.newContext({ viewport: { width: 260, height: 180 } });
    const source = await context.newPage();
    const rendered = await context.newPage();
    try {
      await source.setContent(HTML);
      const expected = await source.screenshot();
      const tree = await captureElementTree(source, "body", { x: 0, y: 0, width: 260, height: 180 });
      const svg = elementTreeToSvg(tree, 260, 180);
      await rendered.setContent(`<body style="margin:0">${svg}</body>`);
      const actual = await rendered.screenshot();
      const a = await sharp(expected).removeAlpha().raw().toBuffer();
      const b = await sharp(actual).removeAlpha().raw().toBuffer();
      let sum = 0;
      for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
      expect(sum / a.length).toBeLessThan(1.5);
    } finally {
      await context.close();
    }
  }, 60_000);
});
