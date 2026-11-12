import type { Browser } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, expect, it } from "vitest";
import { captureElementTree, launchChromium } from "../src/capture/index.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// DM-RN0T12: a viewport-fixed box paints inside its nearest genuine stacking
// context, under that context's opacity, blend and clip-path, while escaping
// overflow clips of ancestors that are not its containing block.
const viewport = { x: 0, y: 0, width: 100, height: 80 };
const FIXED = "position:fixed;left:50px;top:20px;width:30px;height:30px;background:rgb(0,0,255)";
const BOX = "margin:10px;width:40px;height:40px";
let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(async () => closeBrowserSafely(browser), 15_000);

const cases = [
  { name: "opacity ancestor", body: `<div style="${BOX};opacity:.5"><div style="${FIXED}"></div></div>` },
  {
    name: "nested opacity ancestors",
    body: `<div style="${BOX};opacity:.5"><div style="opacity:.5"><div style="${FIXED}"></div></div></div>`,
  },
  {
    name: "mix-blend-mode ancestor",
    body: `<div style="${BOX};mix-blend-mode:multiply;background:yellow"><div style="${FIXED}"></div></div>`,
  },
  { name: "clip-path ancestor", body: `<div style="${BOX};clip-path:inset(0)"><div style="${FIXED}"></div></div>` },
  {
    name: "opacity ancestor with overflow clip",
    body: `<div style="${BOX};opacity:.5;overflow:hidden"><div style="${FIXED}"><div style="width:10px;height:10px;background:lime"></div></div></div>`,
  },
  {
    name: "overflow clip still clips the context's own text",
    body: `<div style="${BOX};opacity:.5;overflow:hidden;font:20px/20px Arial;white-space:nowrap">WWWWWW<div style="${FIXED}"></div></div>`,
  },
  {
    name: "z-index wrapper bounds the fixed box's z-order",
    body: `<div style="${BOX};position:relative;z-index:1"><div style="${FIXED};z-index:1000"></div></div><div style="position:absolute;z-index:2;left:60px;top:30px;width:30px;height:30px;background:red"></div>`,
  },
  {
    name: "containing block keeps its overflow clip",
    body: `<div style="${BOX};transform:translateX(0);overflow:hidden;opacity:.5"><div style="${FIXED}"></div></div>`,
  },
  {
    name: "overflow-only scroller is escaped",
    body: `<div style="${BOX};overflow:hidden"><div style="${FIXED}"></div></div>`,
  },
];

it.each(cases)("matches native paint: $name", async ({ body }) => {
  const page = await browser.newPage({ viewport });
  const output = await browser.newPage({ viewport });
  try {
    await page.setContent(
      `<style>body{margin:0;background:white}</style><div style="width:100px;height:80px;background:rgb(200,200,200)">${body}</div>`,
    );
    const native = await sharp(await page.screenshot())
      .removeAlpha()
      .raw()
      .toBuffer();
    const tree = await captureElementTree(page, "body", viewport);
    await output.setContent(`<style>body{margin:0;background:white}</style>${elementTreeToSvg(tree, 100, 80)}`);
    const actual = await sharp(await output.screenshot())
      .removeAlpha()
      .raw()
      .toBuffer();
    let worst = 0;
    for (let i = 0; i < native.length; i++) worst = Math.max(worst, Math.abs(native[i] - actual[i]));
    // Text antialiasing is the only residual; effect ownership errors are >= 50.
    expect(worst).toBeLessThanOrEqual(2);
  } finally {
    await page.close();
    await output.close();
  }
});
