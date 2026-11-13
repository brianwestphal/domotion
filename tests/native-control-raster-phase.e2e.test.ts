import type { Browser } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, expect, it } from "vitest";
import { captureElementTree, launchChromium } from "../src/capture/index.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// DM-ZYANDV: a block-level native control is rendered in both the box and the
// inline pass. Its Chromium theme stamp must be emitted once (box decoration),
// or its anti-aliased corners composite twice and darken.
const viewport = { x: 0, y: 0, width: 200, height: 160 };
const BUTTON = "display:block;width:40px;height:20px;margin:8px";
let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(async () => closeBrowserSafely(browser), 15_000);

it.each([
  {
    name: "block-level buttons",
    body: `<div style="height:60px"></div><button style="${BUTTON}"></button><button style="${BUTTON}"></button>`,
    stamps: 2,
  },
  { name: "inline button control", body: `<button style="width:40px;height:20px;margin:8px"></button>`, stamps: 1 },
])("emits each native stamp once and matches native paint: $name", async ({ body, stamps }) => {
  const page = await browser.newPage({ viewport });
  const output = await browser.newPage({ viewport });
  try {
    await page.setContent(`<style>body{margin:0;background:white}</style>${body}`);
    const native = await sharp(await page.screenshot())
      .removeAlpha()
      .raw()
      .toBuffer();
    const tree = await captureElementTree(page, "body", viewport);
    const svg = elementTreeToSvg(tree, 200, 160);
    const uses = (svg.match(/<use href="#dmi\d+"/g) ?? []).length;
    const images = (svg.match(/<image href="data:image\/png/g) ?? []).length;
    expect(uses + images).toBe(stamps);
    await output.setContent(`<style>body{margin:0;background:white}</style>${svg}`);
    const actual = await sharp(await output.screenshot())
      .removeAlpha()
      .raw()
      .toBuffer();
    let worst = 0;
    for (let i = 0; i < native.length; i++) worst = Math.max(worst, Math.abs(native[i] - actual[i]));
    // Re-compositing a transparent-background stamp quantizes its corner
    // alpha by one level; a double-composited stamp differed by 26.
    expect(worst).toBeLessThanOrEqual(1);
  } finally {
    await page.close();
    await output.close();
  }
});

// DM-MCWVZQ: the URL-filter / external CSS SVG raster shares the native
// stamp's emission site but is emitted once for block-level owners, including
// one with inline content and a block-level button.
const CONVOLVE =
  '<svg width="0" height="0" style="position:absolute"><filter id="f"><feConvolveMatrix order="3" kernelMatrix="0 0 0 0 1 0 0 0 0"/></filter></svg>';
it.each([
  {
    name: "block owner with inline content",
    body: `${CONVOLVE}<div style="width:60px;height:30px;margin:8px;background:red;filter:url(#f)">Hi <b>x</b><div style="width:10px;height:5px;background:blue"></div></div>`,
  },
  {
    name: "block-level button",
    body: `${CONVOLVE}<button style="display:block;width:60px;height:30px;margin:8px;filter:url(#f)">Go</button>`,
  },
])("emits a URL-filter raster once: $name", async ({ body }) => {
  const page = await browser.newPage({ viewport });
  try {
    await page.setContent(`<style>body{margin:0;background:white}</style>${body}`);
    const svg = elementTreeToSvg(await captureElementTree(page, "body", viewport), 200, 160);
    expect(
      (svg.match(/<image href="data:image\/png/g) ?? []).length + (svg.match(/<use href="#dmi\d+"/g) ?? []).length,
    ).toBe(1);
  } finally {
    await page.close();
  }
});
