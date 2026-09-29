import { afterAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { captureElementTreeWithWarnings, launchChromium } from "../src/index.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

/**
 * A base-select's `::picker-icon` is `counter(..., disclosure-open)` pushed to the inline end, which Blink
 * paints as a symbol marker: a triangle in a square of 0.66 x font-size (ListMarker::RelativeSymbolMarkerRect).
 * The renderer must place that square where Chromium painted it, not at a hand-drawn offset from the box
 * center; the triangle's ink is compared against Chromium's own pixels at 8x.
 */
async function setup() {
  try {
    return { browser: await launchChromium() };
  } catch {
    return null;
  }
}
const env = await setup();
afterAll(async () => closeBrowserSafely(env?.browser), 15_000);
const describeBrowser = env ? describe : describe.skip;

const DSF = 8;
const html = (font: string, style: string) =>
  `<style>select,select::picker(select){appearance:base-select}</style><body style="margin:10px;font:${font}"><select style="width:200px;${style}"><option>One</option></select></body>`;

async function inkOf(png: Buffer, originX: number, originY: number) {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let minX = 1e9;
  let maxX = -1;
  let minY = 1e9;
  let maxY = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * 3] < 128) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  }
  return {
    left: originX + minX / DSF,
    right: originX + (maxX + 1) / DSF,
    top: originY + minY / DSF,
    bottom: originY + (maxY + 1) / DSF,
  };
}

describeBrowser("base-select ::picker-icon", () => {
  it.each([
    ["16px Helvetica", ""],
    ["24px Helvetica", ""],
    ["16px Times", "padding:6px 10px"],
    ["13px Menlo", ""],
  ])("places the disclosure triangle where Chromium paints it (%s %s)", async (font, style) => {
    const context = await env!.browser.newContext({ viewport: { width: 260, height: 90 }, deviceScaleFactor: DSF });
    const page = await context.newPage();
    await page.setContent(html(font, style));
    const box = await page.evaluate(() => {
      const q = document.querySelector("select")!.getBoundingClientRect();
      return { x: q.x, y: q.y, w: q.width, h: q.height };
    });
    // Ink region: right of the value text and inside the border, so neither is scanned.
    const region = { x: box.x + box.w - 40, y: box.y + 3, width: 34, height: box.h - 6 };
    const expected = await inkOf(await page.screenshot({ clip: region }), region.x, region.y);

    const captured = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 260, height: 90 }, {});
    const svg = elementTreeToSvg(captured.tree, 260, 90, {});
    const polygon = /<polygon points="([^"]+)"/.exec(svg);
    expect(polygon).not.toBeNull();
    const pts = polygon![1].split(/\s+/).map((p) => p.split(",").map(Number));
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    // Chromium's ink is antialiased to 1/8 px; a quarter pixel is tighter than any fitted offset was.
    expect(Math.abs(Math.min(...xs) - expected.left)).toBeLessThan(0.3);
    expect(Math.abs(Math.max(...xs) - expected.right)).toBeLessThan(0.3);
    expect(Math.abs(Math.min(...ys) - expected.top)).toBeLessThan(0.3);
    expect(Math.abs(Math.max(...ys) - expected.bottom)).toBeLessThan(0.3);
    await context.close();
  });
});
