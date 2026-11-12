import type { Browser } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, expect, it } from "vitest";
import { captureElementTreeWithWarnings, launchChromium } from "../src/capture/index.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// DM-1C56DE: Blink's CssClip node (LayoutBox::ClipRect, UpdateCssClip and
// UpdateOutOfFlowContext at Chromium 6b5a1b80) clips an out-of-flow owner's
// own paint and every descendant, fixed descendants included.
const viewport = { x: 0, y: 0, width: 100, height: 80 };
const OWNER = "position:absolute;left:10px;top:10px;width:60px;height:50px;background:rgb(200,255,200)";
const CHILD = "position:absolute;left:5px;top:5px;width:70px;height:60px;background:blue";
let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(async () => closeBrowserSafely(browser), 15_000);

const cases = [
  { name: "own paint", body: `<div style="${OWNER};clip:rect(0,30px,30px,0)"></div>` },
  {
    name: "in-flow child",
    body: `<div style="${OWNER};clip:rect(0,30px,30px,0)"><div style="width:60px;height:50px;background:blue"></div></div>`,
  },
  { name: "absolute child", body: `<div style="${OWNER};clip:rect(0,30px,30px,0)"><div style="${CHILD}"></div></div>` },
  {
    name: "fixed child of a non-containing owner",
    body: `<div style="${OWNER};clip:rect(0,30px,30px,0)"><div style="position:fixed;left:15px;top:15px;width:50px;height:40px;background:blue"></div></div>`,
  },
  {
    name: "fixed child of a stacking-context owner",
    body: `<div style="${OWNER};z-index:3;clip:rect(0,30px,30px,0)"><div style="position:fixed;left:15px;top:15px;width:50px;height:40px;background:blue"></div></div>`,
  },
  {
    name: "absolute grandchild through a relative box",
    body: `<div style="${OWNER};clip:rect(0,30px,30px,0)"><div style="position:relative"><div style="${CHILD}"></div></div></div>`,
  },
  {
    name: "auto sides",
    body: `<div style="${OWNER};clip:rect(auto,30px,auto,5px)"><div style="${CHILD}"></div></div>`,
  },
  {
    name: "rect larger than the box",
    body: `<div style="${OWNER};clip:rect(-10px,80px,70px,-10px)"><div style="${CHILD}"></div></div>`,
  },
  {
    name: "nested owners intersect",
    body: `<div style="${OWNER};clip:rect(0,40px,40px,0)"><div style="position:absolute;left:10px;top:10px;width:50px;height:40px;clip:rect(0,40px,20px,0);background:blue"><div style="width:50px;height:40px;background:red"></div></div></div>`,
  },
  {
    name: "generated child",
    body: `<style>#c::after{content:"";position:absolute;left:5px;top:5px;width:50px;height:40px;background:blue}</style><div id="c" style="${OWNER};clip:rect(0,30px,30px,0)"></div>`,
  },
  {
    name: "visually hidden text",
    body: `<div style="position:absolute;left:10px;top:10px;width:1px;height:1px;clip:rect(0 0 0 0);white-space:nowrap;font:20px Arial">Hidden text</div>`,
  },
  {
    name: "static and relative boxes ignore clip",
    body: `<div style="margin:10px;width:30px;height:20px;clip:rect(0,10px,10px,0);background:green"></div><div style="position:relative;left:50px;width:30px;height:20px;clip:rect(0,10px,10px,0);background:green"></div>`,
  },
];

it.each(cases)("matches native paint: $name", async ({ body }) => {
  const page = await browser.newPage({ viewport });
  const output = await browser.newPage({ viewport });
  try {
    await page.setContent(`<style>body{margin:0;background:white}</style>${body}`);
    const native = await sharp(await page.screenshot())
      .removeAlpha()
      .raw()
      .toBuffer();
    const { tree, warnings } = await captureElementTreeWithWarnings(page, "body", viewport);
    expect(warnings.filter((warning) => warning.feature === "clip")).toEqual([]);
    await output.setContent(`<style>body{margin:0;background:white}</style>${elementTreeToSvg(tree, 100, 80)}`);
    const actual = await sharp(await output.screenshot())
      .removeAlpha()
      .raw()
      .toBuffer();
    expect(actual.equals(native)).toBe(true);
  } finally {
    await page.close();
    await output.close();
  }
});
