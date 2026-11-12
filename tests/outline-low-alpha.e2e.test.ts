import { afterAll, describe, expect, it } from "vitest";
import type { Browser } from "@playwright/test";
import { captureElementTree, elementTreeToSvg, launchChromium } from "../src/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// DM-HGGQMW: Blink paints an outline edge whenever its color is not fully
// transparent (BorderEdge::HasVisibleColorAndStyle, core/style/border_edge.cc
// at 6b5a1b80). An alpha of .004 still quantizes to visible 8-bit pixels, so
// the renderer must not apply its own visibility floor to outline color.

const env = await (async () => {
  try {
    return { browser: await launchChromium() };
  } catch {
    return null;
  }
})();
afterAll(async () => {
  await closeBrowserSafely(env?.browser);
}, 15_000);
const describeBrowser = env ? describe : describe.skip;

const VIEW = { x: 0, y: 0, width: 100, height: 100 };

/** Pixels with nonzero alpha in a transparent-background screenshot of `html`. */
async function paintedPixels(browser: Browser, html: string): Promise<number> {
  const page = await browser.newPage({ viewport: { width: VIEW.width, height: VIEW.height }, deviceScaleFactor: 1 });
  try {
    await page.setContent(html, { waitUntil: "load" });
    const png = (await page.screenshot({ omitBackground: true })).toString("base64");
    return await page.evaluate(async (data) => {
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      const { data: rgba } = context.getImageData(0, 0, image.width, image.height);
      let count = 0;
      for (let i = 3; i < rgba.length; i += 4) if (rgba[i]! > 0) count++;
      return count;
    }, png);
  } finally {
    await page.close();
  }
}

describeBrowser("low-alpha outline paint (DM-HGGQMW)", () => {
  for (const sample of [
    { color: "rgba(255,0,0,.005)", painted: true },
    { color: "rgba(255,0,0,0)", painted: false },
  ]) {
    it(`matches native coverage for outline-color ${sample.color}`, async () => {
      const source = `<!doctype html><style>body{margin:0}#probe{position:absolute;left:20px;top:20px;width:20px;height:20px;outline:2px solid ${sample.color}}</style><div id="probe"></div>`;
      const native = await paintedPixels(env!.browser, source);

      const page = await env!.browser.newPage({ viewport: { width: VIEW.width, height: VIEW.height } });
      let svg: string;
      try {
        await page.setContent(source, { waitUntil: "load" });
        svg = elementTreeToSvg(await captureElementTree(page, "body", VIEW), VIEW.width, VIEW.height);
      } finally {
        await page.close();
      }
      const rendered = await paintedPixels(
        env!.browser,
        `<!doctype html><style>body{margin:0}svg{display:block}</style>${svg}`,
      );

      expect(native > 0).toBe(sample.painted);
      expect(rendered).toBe(native);
    });
  }
});
