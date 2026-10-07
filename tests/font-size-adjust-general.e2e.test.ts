import { afterAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { captureElementTree, elementTreeToSvg, launchChromium } from "../src/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

const WIDTH = 360;
const HEIGHT = 110;
const env = await (async () => {
  try {
    return { browser: await launchChromium() };
  } catch {
    return null;
  }
})();
afterAll(async () => closeBrowserSafely(env?.browser), 15_000);
const describeBrowser = env != null ? describe : describe.skip;

async function inkBounds(png: Buffer): Promise<{ left: number; right: number }> {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let left = info.width;
  let right = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const offset = (y * info.width + x) * info.channels;
      if (data[offset] < 200 && data[offset + 1] < 200 && data[offset + 2] < 200) {
        left = Math.min(left, x);
        right = Math.max(right, x);
      }
    }
  }
  return { left, right };
}

describeBrowser("font-size-adjust metrics across selected families", () => {
  it.each([
    ["serif", "none", ""],
    ["serif", "0.8", ""],
    ["serif", "cap-height 0.8", ""],
    ["serif", "ch-width 0.8", ""],
    ["serif", "ic-width 0.8", ""],
    ["serif", "ic-height 0.8", ""],
    ["serif", "from-font", ""],
    ["serif", "0", ""],
    ["sans-serif", "cap-height 0.8", ""],
    ["monospace", "ch-width 0.8", ""],
    ["system-ui", "0.8", 'font-variation-settings:"wdth" 85;'],
    ["serif", "0.8", "", "MMMM水xxxx"],
    ["serif", "from-font", "", "MMMM水xxxx"],
    ["serif", "none", "", "水"],
    ["serif", "0.8", "", "水"],
    ["serif", "from-font", "", "水"],
    ["serif", "0.65", ""],
    ["serif", "0.8", ""],
    ['"Definitely Missing Font"', "0.8", ""],
  ] as const)(
    "case %#: matches %s with %s and %s text %s",
    async (family, sizeAdjust, extraStyle, requestedText) => {
      const text = requestedText ?? "MMMMxxxx";
      const page = await env!.browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
      const svgPage = await env!.browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
      try {
        await page.setContent(
          `<div id="root" style="box-sizing:border-box;width:${WIDTH}px;height:${HEIGHT}px;background:white;padding:16px">` +
            `<span style="font:400 16px ${family};font-size-adjust:${sizeAdjust};${extraStyle}color:black">${text}</span></div>`,
        );
        const expected = await page.locator("#root").screenshot();
        const tree = await captureElementTree(page, "#root", { x: 0, y: 0, width: WIDTH, height: HEIGHT });
        for (const renderTextMode of ["paths", "embedded-font"] as const) {
          const svg = elementTreeToSvg(tree, WIDTH, HEIGHT, { renderTextMode });
          await svgPage.setContent(
            `<img alt="rendered" src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}">`,
          );
          const actual = await svgPage.locator("img").screenshot();
          const expectedInk = await inkBounds(expected);
          const actualInk = await inkBounds(actual);
          expect(actualInk.left - expectedInk.left, renderTextMode).toBeGreaterThanOrEqual(-2);
          expect(actualInk.left - expectedInk.left, renderTextMode).toBeLessThanOrEqual(2);
          expect(actualInk.right - expectedInk.right, renderTextMode).toBeGreaterThanOrEqual(-2);
          expect(actualInk.right - expectedInk.right, renderTextMode).toBeLessThanOrEqual(2);
        }
      } finally {
        await page.close();
        await svgPage.close();
      }
    },
    60_000,
  );
});
