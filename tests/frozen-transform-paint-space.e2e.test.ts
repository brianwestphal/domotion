import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import type { Browser } from "@playwright/test";
import { captureElementTree, elementTreeToSvg, launchChromium } from "../src/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// Static translate/scale transforms are captured untransformed and re-applied
// by the renderer's <g transform>, because Blink snaps box paint in local space
// before applying the transform (ToPixelSnappedRect, Chromium 7d859f27
// core/paint/box_painter_base.cc:1058). Chromium raster surfaces painted by the
// live page must land in the same place. Each case renders native Chromium and
// the SVG at the same viewport and counts pixels that differ by more than 40.

const WIDTH = 220;
const HEIGHT = 140;
let browser: Browser;

beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(async () => closeBrowserSafely(browser), 15_000);

async function differingPixels(html: string): Promise<{ count: number; svg: string }> {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
  const out = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
  try {
    await page.setContent(`<style>body{margin:0;background:white;font:14px sans-serif}</style>${html}`);
    const native = await sharp(await page.screenshot())
      .removeAlpha()
      .raw()
      .toBuffer();
    const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: WIDTH, height: HEIGHT });
    const svg = elementTreeToSvg(tree, WIDTH, HEIGHT);
    await out.setContent(`<style>body{margin:0;background:white}</style>${svg}`);
    const actual = await sharp(await out.screenshot())
      .removeAlpha()
      .raw()
      .toBuffer();
    let count = 0;
    for (let offset = 0; offset < native.length; offset += 3) {
      const delta = Math.max(
        Math.abs(native[offset] - actual[offset]),
        Math.abs(native[offset + 1] - actual[offset + 1]),
        Math.abs(native[offset + 2] - actual[offset + 2]),
      );
      if (delta > 40) count++;
    }
    return { count, svg };
  } finally {
    await page.close();
    await out.close();
  }
}

const container = (transform: string, content: string): string =>
  `<div style="margin:20px;transform:${transform};transform-origin:0 0;width:150px">${content}</div>`;

describe("frozen-transform paint space", () => {
  it.each([
    [
      "fractional translate outline",
      `<div style="width:20px;height:20px;margin:20.5px;transform:translate(-.5px,-.5px);outline:2px solid red"></div>`,
    ],
    [
      "scaled border",
      `<div style="width:20px;height:20px;margin:30px;transform:scale(1.5);border:2px solid blue"></div>`,
    ],
  ])("paints the %s in the box's local space", async (_name, html) => {
    expect((await differingPixels(html)).count).toBe(0);
  });

  it.each([["translate(10.5px,10px)"], ["scale(1.2)"], ["rotate(5deg)"]])(
    "places native control, decoration and replaced rasters inside %s",
    async (transform) => {
      for (const content of [
        `<button>Press</button>`,
        `<input type=checkbox checked>`,
        `<input type=range>`,
        `<input value="hi" style="width:80px">`,
        `<canvas width=40 height=30 id=c></canvas><script>const x=document.getElementById('c').getContext('2d');x.fillStyle='purple';x.fillRect(5,5,30,20)</script>`,
      ]) {
        const { count } = await differingPixels(container(transform, content));
        expect(count, `${content} under ${transform}`).toBeLessThanOrEqual(5);
      }
    },
  );

  it("leaves no style attribute on a frozen owner that had none", async () => {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
    try {
      await page.setContent(
        `<style>#owner{transform:translate(10.5px,10px) scale(1.2);transform-origin:0 0}</style><div id="owner"><input value="hi"><canvas width="20" height="10"></canvas></div>`,
      );
      await captureElementTree(page, "body", { x: 0, y: 0, width: WIDTH, height: HEIGHT });
      expect(await page.locator("#owner").evaluate((owner) => owner.getAttribute("style"))).toBeNull();
    } finally {
      await page.close();
    }
  });

  it("resolves a percentage translate longhand against the border box", async () => {
    const { count } = await differingPixels(
      `<div style="position:relative;height:100px"><div style="position:absolute;left:110px;top:50px;width:80px;height:20px;translate:-50% 8px;background:#166534"></div></div>`,
    );
    expect(count).toBe(0);
  });
});
