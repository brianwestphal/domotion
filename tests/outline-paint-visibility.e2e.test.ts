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

/** Alpha channel of a transparent-background screenshot of `html`. */
async function alphaMap(browser: Browser, html: string): Promise<number[]> {
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
      return Array.from(rgba.filter((_, index) => index % 4 === 3));
    }, png);
  } finally {
    await page.close();
  }
}

async function renderedSvg(browser: Browser, source: string): Promise<string> {
  const page = await browser.newPage({ viewport: { width: VIEW.width, height: VIEW.height } });
  try {
    await page.setContent(source, { waitUntil: "load" });
    return elementTreeToSvg(await captureElementTree(page, "body", VIEW), VIEW.width, VIEW.height);
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

// DM-RGE1V9: Blink keeps an empty pixel-snapped rect for a normal outline, but
// not for a focus ring (OutlinePainter::PaintOutlineRects, outline_painter.cc:924
// at 6b5a1b80), so a zero-area box still paints its outline.
describeBrowser("zero-area box outline paint (DM-RGE1V9)", () => {
  for (const sample of [
    { name: "zero width", size: "width:0;height:20px", outline: "2px solid red", painted: true },
    { name: "zero height", size: "width:20px;height:0", outline: "2px solid red", painted: true },
    { name: "zero both", size: "width:0;height:0", outline: "2px solid red", painted: true },
    { name: "focus ring", size: "width:0;height:0", outline: "2px auto red", painted: false },
    { name: "no outline", size: "width:0;height:20px", outline: "none", painted: false },
  ]) {
    it(`matches native coverage for a ${sample.name} box`, async () => {
      const source = `<!doctype html><style>body{margin:0}#probe{position:absolute;left:20px;top:20px;${sample.size};outline:${sample.outline}}</style><div id="probe"></div>`;
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

// DM-9X9M8A: a solid rounded outline fills between two contours whose radii
// are the constrained border radii grown per component by each side's outset
// (ContouredBorderGeometry::PixelSnappedContouredBorderWithOutsets and
// FloatRoundedRect::Radii::Outset at 6b5a1b80). Per-corner and elliptical
// radii used to collapse to the top-left corner's scalar radius. Curve edges
// keep a few levels of anti-aliasing difference; a geometry error is a full
// coverage difference.
describeBrowser("per-corner outline radii (DM-9X9M8A)", () => {
  for (const radius of ["8px/4px", "5px 10px 0px 5px", "0 12px", "5px"]) {
    for (const offset of ["0", "3px", "-2px"]) {
      it(`matches native outline coverage for border-radius ${radius}, outline-offset ${offset}`, async () => {
        const source = `<!doctype html><style>body{margin:0}#probe{position:absolute;left:20px;top:20px;width:30px;height:24px;border-radius:${radius};outline:3px solid red;outline-offset:${offset}}</style><div id="probe"></div>`;
        const native = await alphaMap(env!.browser, source);
        const svg = await renderedSvg(env!.browser, source);
        const rendered = await alphaMap(
          env!.browser,
          `<!doctype html><style>body{margin:0}svg{display:block}</style>${svg}`,
        );
        const worst = Math.max(...native.map((alpha, index) => Math.abs(alpha - rendered[index]!)));
        expect(native.some((alpha) => alpha > 0)).toBe(true);
        expect(worst).toBeLessThanOrEqual(16);
      });
    }
  }
});
