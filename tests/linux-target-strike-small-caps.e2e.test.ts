import { afterAll, describe, expect, it } from "vitest";
import sharp from "sharp";

import { launchChromium } from "../src/index.js";
import { captureElementTree, elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import { isGlyphHelperAvailable } from "../src/render/glyph-helper.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

const W = 360;
const H = 80;
const HTML = `<!doctype html><style>
html,body{margin:0;background:#fff}
#line{position:absolute;left:20px;top:20px;margin:0;color:#000;
  font:18px/24px Georgia,"Times New Roman",serif;font-variant-caps:small-caps}
</style><p id="line">T height</p>`;

interface Box { x: number; y: number; width: number; height: number }

async function inkBox(png: Buffer, range: Box): Promise<Box | null> {
  const decoded = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const left = Math.max(0, Math.floor(range.x) - 2);
  const right = Math.min(decoded.info.width, Math.ceil(range.x + range.width) + 2);
  let minX = right, minY = decoded.info.height, maxX = -1, maxY = -1;
  for (let y = 0; y < decoded.info.height; y++) {
    for (let x = left; x < right; x++) {
      const offset = (y * decoded.info.width + x) * decoded.info.channels;
      if (decoded.data[offset] >= 128 || decoded.data[offset + 1] >= 128 || decoded.data[offset + 2] >= 128) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return maxX < minX ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

async function setup() {
  if (process.platform !== "linux") return null;
  try { return { browser: await launchChromium() }; } catch { return null; }
}
const env = await setup();
afterAll(async () => { await closeBrowserSafely(env?.browser); }, 15_000);
const describeLinuxBrowser = env ? describe : describe.skip;

describeLinuxBrowser("Linux mixed-size target strikes for synthesized small caps", () => {
  it("matches native 18px/13px ink heights and proves the disabled path diverges", async () => {
    expect(isGlyphHelperAvailable()).toBe(true);
    const context = await env!.browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    const source = await context.newPage();
    const rendered = await context.newPage();
    const previous = process.env.DOMOTION_LINUX_TARGET_STRIKE;
    try {
      await source.setContent(HTML, { waitUntil: "load" });
      const charRects = await source.locator("#line").evaluate((line) => {
        const text = line.firstChild!;
        const boxAt = (index: number) => {
          const range = document.createRange();
          range.setStart(text, index);
          range.setEnd(text, index + 1);
          const rect = range.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        };
        return { full: boxAt(0), small: boxAt(2) };
      });
      const expected = await source.screenshot({ clip: { x: 0, y: 0, width: W, height: H } });
      const tree = await captureElementTree(source, "body", { x: 0, y: 0, width: W, height: H });

      process.env.DOMOTION_LINUX_TARGET_STRIKE = "0";
      const disabledSvg = elementTreeToSvg(tree, W, H);
      await rendered.setContent(`<body style="margin:0">${disabledSvg}</body>`, { waitUntil: "load" });
      await rendered.evaluate(() => document.fonts.ready);
      const disabled = await rendered.screenshot({ clip: { x: 0, y: 0, width: W, height: H } });

      process.env.DOMOTION_LINUX_TARGET_STRIKE = "1";
      const enabledSvg = elementTreeToSvg(tree, W, H);
      await rendered.setContent(`<body style="margin:0">${enabledSvg}</body>`, { waitUntil: "load" });
      await rendered.evaluate(() => document.fonts.ready);
      const enabled = await rendered.screenshot({ clip: { x: 0, y: 0, width: W, height: H } });

      const expectedFull = await inkBox(expected, charRects.full);
      const expectedSmall = await inkBox(expected, charRects.small);
      const disabledFull = await inkBox(disabled, charRects.full);
      const disabledSmall = await inkBox(disabled, charRects.small);
      const enabledFull = await inkBox(enabled, charRects.full);
      const enabledSmall = await inkBox(enabled, charRects.small);

      expect(expectedFull).not.toBeNull();
      expect(expectedSmall).not.toBeNull();
      expect([enabledFull!.y, enabledFull!.height, enabledSmall!.y, enabledSmall!.height])
        .toEqual([expectedFull!.y, expectedFull!.height, expectedSmall!.y, expectedSmall!.height]);
      expect([disabledFull!.y, disabledFull!.height, disabledSmall!.y, disabledSmall!.height])
        .not.toEqual([expectedFull!.y, expectedFull!.height, expectedSmall!.y, expectedSmall!.height]);

      const fullFamily = /font-family="(dmf\d+)" font-size="18" text-rendering="geometricPrecision"/.exec(enabledSvg)?.[1];
      const smallFamily = /font-family="(dmf\d+)" font-size="13" text-rendering="geometricPrecision"/.exec(enabledSvg)?.[1];
      expect(fullFamily).toBeTruthy();
      expect(smallFamily).toBeTruthy();
      expect(fullFamily).not.toBe(smallFamily);
    } finally {
      if (previous == null) delete process.env.DOMOTION_LINUX_TARGET_STRIKE;
      else process.env.DOMOTION_LINUX_TARGET_STRIKE = previous;
      await context.close();
    }
  }, 60_000);
});
