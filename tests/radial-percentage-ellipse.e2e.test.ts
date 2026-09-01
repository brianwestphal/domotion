import { afterAll, describe, expect, it } from "vitest";
import sharp from "sharp";

import {
  captureElementTreeWithWarnings,
  elementTreeToSvg,
  launchChromium,
} from "../src/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

const W = 300;
const H = 180;

async function meanAbsoluteError(left: Buffer, right: Buffer): Promise<number> {
  const [a, b] = await Promise.all([
    sharp(left).removeAlpha().raw().toBuffer(),
    sharp(right).removeAlpha().raw().toBuffer(),
  ]);
  expect(b.length).toBe(a.length);
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

const env = await (async () => {
  try { return { browser: await launchChromium() }; } catch { return null; }
})();
afterAll(async () => closeBrowserSafely(env?.browser), 15_000);
const describeBrowser = env == null ? describe.skip : describe;

describeBrowser("body-propagated percentage radial gradient (DM-2649)", () => {
  it("retains Blink's width/height-based ellipse in the captured SVG", async () => {
    const context = await env!.browser.newContext({
      viewport: { width: W, height: H },
      deviceScaleFactor: 1,
    });
    const source = await context.newPage();
    const generated = await context.newPage();
    try {
      await source.setContent(`<!doctype html><style>
        html{margin:0;background:transparent}
        body{margin:0;width:${W}px;height:${H}px;background:radial-gradient(120% 130% at 0% 0%,#1d2740 0%,#0b1020 60%)}
      </style>`);
      const expected = await source.screenshot();
      const capture = await captureElementTreeWithWarnings(source, "body", {
        x: 0, y: 0, width: W, height: H,
      });
      expect(capture.tree[0]?.styles.backgroundAttachmentGeometry?.canvas?.owner)
        .toBe("body-propagated");
      const svg = elementTreeToSvg(capture.tree, W, H);
      expect(svg).toContain("<radialGradient");
      expect(svg).toContain('r="360"');
      expect(svg).toContain('scale(1 0.65)');

      await generated.setContent(`<style>html,body{margin:0}</style>${svg}`);
      const actual = await generated.screenshot();
      expect(await meanAbsoluteError(expected, actual)).toBeLessThan(0.35);
    } finally {
      await context.close();
    }
  }, 60_000);
});
