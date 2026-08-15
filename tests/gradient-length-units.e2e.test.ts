import { afterAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { launchChromium } from "../src/index.js";
import { captureElementTree, elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// DM-2194: Chromium resolves font-relative gradient lengths at computed-value
// time, in the source element's font/root-font context, but preserves percentage
// terms until the gradient reference box is known. This oracle compares the
// browser paint with the captured SVG rather than merely testing parser output.
const W = 240, H = 140;
const HTML = `<!doctype html><style>
html{font-size:20px}body{margin:0;background:white}
#x{width:200px;height:100px;font-size:12px;
background:linear-gradient(90deg,#f00 2em,#0f0 calc(50% + 1rem),#00f 90%)}
</style><div id=x></div>`;

async function setup() {
  try { return { browser: await launchChromium() }; } catch { return null; }
}
const env = await setup();
afterAll(async () => { await closeBrowserSafely(env?.browser); }, 15_000);
const describeBrowser = env ? describe : describe.skip;

describeBrowser("gradient font-relative length Chromium image oracle (DM-2194)", () => {
  it("matches Chromium after em/rem become px and calc percentage resolves against the box", async () => {
    const ctx = await env!.browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    const source = await ctx.newPage();
    const rendered = await ctx.newPage();
    try {
      await source.setContent(HTML, { waitUntil: "load" });
      expect(await source.locator("#x").evaluate((el) => getComputedStyle(el).backgroundImage))
        .toContain("24px");
      expect(await source.locator("#x").evaluate((el) => getComputedStyle(el).backgroundImage))
        .toContain("calc(50% + 20px)");
      const expected = await source.screenshot({ clip: { x: 0, y: 0, width: W, height: H } });
      const tree = await captureElementTree(source, "body", { x: 0, y: 0, width: W, height: H });
      const svg = elementTreeToSvg(tree, W, H);
      await rendered.setContent(`<body style="margin:0">${svg}</body>`, { waitUntil: "load" });
      const actual = await rendered.screenshot({ clip: { x: 0, y: 0, width: W, height: H } });
      const a = await sharp(expected).removeAlpha().raw().toBuffer();
      const b = await sharp(actual).removeAlpha().raw().toBuffer();
      let sum = 0;
      for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
      expect(sum / a.length).toBeLessThan(1.5);
    } finally {
      await ctx.close();
    }
  }, 60_000);
});
