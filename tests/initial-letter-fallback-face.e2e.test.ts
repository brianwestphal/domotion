import { afterAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { captureElementTree, elementTreeToSvg, launchChromium } from "../src/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

const W = 360;
const H = 180;
const HTML = `<!doctype html><style>
  body { margin: 0; font: 17px/28px Georgia, serif; }
  p { margin: 0; width: 340px; }
  p::first-letter {
    initial-letter: 4; float: left;
    font-family: "Definitely Missing Initial Letter", Georgia, serif;
    font-size: 5em; line-height: .85;
    padding: 8px 14px 4px; margin-right: 12px;
    color: white; background: #4338ca;
  }
</style><p>Beyond the initial letter, this sentence wraps around the cap.</p>`;

async function setup() {
  try { return { browser: await launchChromium() }; } catch { return null; }
}
const env = await setup();
afterAll(async () => { await closeBrowserSafely(env?.browser); }, 15_000);
const describeBrowser = env ? describe : describe.skip;

describeBrowser("initial-letter fallback-face sizing", () => {
  it("fits the face Domotion resolves to Chromium's recorded ink box", async () => {
    const context = await env!.browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    const source = await context.newPage();
    const rendered = await context.newPage();
    try {
      await source.setContent(HTML, { waitUntil: "load" });
      const expected = await source.screenshot();
      const tree = await captureElementTree(source, "body", { x: 0, y: 0, width: W, height: H });
      const svg = elementTreeToSvg(tree, W, H);
      await rendered.setContent(`<body style="margin:0">${svg}</body>`, { waitUntil: "load" });
      const actual = await rendered.screenshot();

      const a = await sharp(expected).removeAlpha().raw().toBuffer();
      const b = await sharp(actual).removeAlpha().raw().toBuffer();
      let sum = 0;
      for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
      expect(sum / a.length).toBeLessThan(2.5);
    } finally {
      await context.close();
    }
  }, 60_000);
});
