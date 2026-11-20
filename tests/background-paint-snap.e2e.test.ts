import type { Browser } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, expect, it } from "vitest";
import { captureElementTree, launchChromium } from "../src/capture/index.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// Backgrounds paint from pixel-snapped local rects (Chromium 7d859f27): the
// color fills ToPixelSnappedRect of the paint rect or, when rounded, the
// PixelSnappedContouredBorder (core/paint/box_painter_base.cc:1056-1058,
// 1213-1214, 1265), and image/gradient layers use ToPixelSnappedRect of the
// contracted destination and positioning areas
// (core/paint/background_image_geometry.cc:391-401). Full RGBA must match.
const viewport = { x: 0, y: 0, width: 100, height: 100 };
let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(async () => closeBrowserSafely(browser), 15_000);
const rgba = async (bytes: Buffer) => sharp(bytes).ensureAlpha().raw().toBuffer();
const svgImage = (w: number, h: number, fill: string) =>
  `url('data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22${w}%22 height=%22${h}%22%3E%3Crect width=%22${fill}%22 height=%22${fill}%22 fill=%22red%22/%3E%3C/svg%3E')`;

it.each([
  { name: "half-pixel color", own: "background:red;margin:20.5px" },
  { name: "rounded half-pixel color", own: "background:red;margin:20.5px;border-radius:5px" },
  { name: "quarter-pixel color", own: "background:red;margin:20.25px 20.75px" },
  { name: "fractional-width color", own: "background:red;width:20.5px" },
  { name: "translucent color", own: "background:rgba(255,0,0,.5);margin:20.5px" },
  { name: "color under a translucent border", own: "background:red;border:3px solid rgba(0,0,255,.5);margin:20.5px" },
  { name: "color under an own translate", own: "background:red;margin:20.5px;transform:translate(.25px,.5px)" },
  { name: "color under an x-only scale", own: "background:red;margin:20.5px;transform:scale(1.5,1)" },
  { name: "gradient", own: "background:linear-gradient(red,blue);margin:20.5px" },
  {
    name: "rounded gradient",
    own: "background:linear-gradient(90deg,red,blue);margin:20.25px;border-radius:5px",
  },
  {
    name: "padding-box gradient",
    own: "background:linear-gradient(red,blue) padding-box;border:3px solid transparent;margin:20.5px",
  },
  {
    name: "content-box gradient",
    own: "background:linear-gradient(red,blue) content-box;padding:2.25px;margin:20.5px",
  },
  { name: "positioned image", own: `background:${svgImage(10, 10, "10")} no-repeat 2px 3px;margin:20.5px` },
  { name: "repeated image", own: `background:${svgImage(7, 7, "4")};margin:20.5px` },
  { name: "covering image", own: `background:${svgImage(10, 5, "5")} center/cover;margin:20.25px 20.75px` },
])("paints a $name at Blink's snapped rect", async ({ own }) => {
  const page = await browser.newPage({ viewport }),
    output = await browser.newPage({ viewport });
  try {
    await page.setContent(
      `<style>body{margin:0}#only{width:20px;height:20px;${own}}</style><div><div id="only"></div></div>`,
    );
    const source = await rgba(await page.screenshot({ omitBackground: true }));
    await output.setContent(
      "<style>body{margin:0}</style>" + elementTreeToSvg(await captureElementTree(page, "body", viewport), 100, 100),
    );
    expect(await rgba(await output.screenshot({ omitBackground: true }))).toEqual(source);
  } finally {
    await page.close();
    await output.close();
  }
});
