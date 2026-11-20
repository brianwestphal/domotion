import type { Browser, Page } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureElementTree, launchChromium } from "./index.js";
import { closeBrowserSafely } from "../test-support/close-browser-safely.js";
import { elementTreeToSvg } from "../render/element-tree-to-svg.js";
import { forEachElement } from "../tree-ops/for-each-element.js";
import type { CapturedElement } from "./types.js";

// DM-SC2P4R: a non-positioned ::after that is a native stacking context is a
// stacked layer, collected into the root z-order list after an EARLIER
// positioned z:auto sibling. Capture records the DOMSnapshot fact; the
// negative control strips it and must reproduce the old 3600 px miss.

const W = 120;
const H = 120;
const blue = `<div style="position:absolute;left:0;top:0;width:60px;height:60px;background:rgb(0,0,255)"></div>`;
const html = (style: string, host = "") =>
  `<style>body{margin:0;background:white}#h{${host}}#h::after{content:"";display:block;width:60px;height:60px;background:rgb(128,0,128);${style}}</style>${blue}<div id=h></div>`;

let browser: Browser;
let page: Page;
let generated: Page;
beforeAll(async () => {
  browser = await launchChromium();
  page = await browser.newPage({ viewport: { width: W, height: H } });
  generated = await browser.newPage({ viewport: { width: W, height: H } });
});
afterAll(async () => {
  await closeBrowserSafely(browser);
}, 15_000);

const rgbaPixels = async (png: Buffer) => sharp(png).ensureAlpha().raw().toBuffer();
const diff = (a: Buffer, b: Buffer) => {
  let count = 0;
  for (let i = 0; i < a.length; i += 4) {
    let d = 0;
    for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(a[i + c] - b[i + c]));
    if (d > 2) count++;
  }
  return count;
};
const render = async (tree: CapturedElement[]) => {
  await generated.setContent(`<style>html,body{margin:0;background:white}</style>${elementTreeToSvg(tree, W, H)}`);
  return rgbaPixels(await generated.screenshot());
};
const compare = async (source: string) => {
  await page.setContent(source);
  const expected = await rgbaPixels(await page.screenshot());
  const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: W, height: H });
  const flags: Array<true | undefined> = [];
  forEachElement(tree, (element) => {
    for (const record of element.pseudoFragments ?? []) flags.push(record.paint.stackingContext);
  });
  const actual = diff(expected, await render(tree));
  forEachElement(tree, (element) => {
    for (const record of element.pseudoFragments ?? []) delete record.paint.stackingContext;
  });
  const legacy = diff(expected, await render(tree));
  return { flags, actual, legacy };
};

describe("natively stacked non-positioned generated boxes (DM-SC2P4R)", () => {
  it.each([
    ["opacity", html("opacity:.99")],
    ["transform", html("transform:translateX(0)")],
    ["filter", html("filter:blur(0)")],
    ["isolation", html("isolation:isolate")],
    ["contain:paint (box row only)", html("contain:paint")],
    ["flex item z-index:1", html("z-index:1", "display:flex")],
    ["grid item z-index:1", html("z-index:1", "display:grid")],
  ])(
    "%s paints in the z-order list",
    async (_name, source) => {
      const result = await compare(source);
      expect(result.flags).toEqual([true]);
      expect(result.actual).toBe(0);
      expect(result.legacy).toBe(3600);
    },
    60_000,
  );

  it.each([
    ["plain block", html("")],
    ["static non-flex z-index", html("z-index:5")],
    ["flex item z-index:auto", html("", "display:flex")],
  ])(
    "%s is not stacked",
    async (_name, source) => {
      const result = await compare(source);
      expect(result.flags).toEqual([undefined]);
      expect(result.actual).toBe(0);
      expect(result.legacy).toBe(0);
    },
    60_000,
  );
});
