import type { Browser, Page } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureElementTree, launchChromium } from "./index.js";
import { closeBrowserSafely } from "../test-support/close-browser-safely.js";
import { elementTreeToSvg } from "../render/element-tree-to-svg.js";

// DM-C5GEMW: a `z-index:-1` positioned generated box of a non-stacking host is
// a negative z-order child of the nearest stacking context, so the context's
// foreground block backgrounds (a non-transferred body, a wrapper) paint over
// it. Before, the generated box painted locally with its host, above those
// backgrounds (10000 and 6400 px in the first two cases).

const W = 120;
const H = 120;
const purple = "rgb(128,0,128)";
const after = (inset = "0") =>
  `#h{position:relative;width:80px;height:80px}#h::after{content:"";position:absolute;inset:${inset};background:${purple};z-index:-1}`;

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
const diffAgainstChromium = async (html: string) => {
  await page.setContent(html);
  const expected = await rgbaPixels(await page.screenshot());
  const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: W, height: H });
  await generated.setContent(`<style>html,body{margin:0;background:white}</style>${elementTreeToSvg(tree, W, H)}`);
  const actual = await rgbaPixels(await generated.screenshot());
  let diff = 0;
  for (let i = 0; i < expected.length; i += 4) {
    if (
      expected[i] !== actual[i] ||
      expected[i + 1] !== actual[i + 1] ||
      expected[i + 2] !== actual[i + 2] ||
      expected[i + 3] !== actual[i + 3]
    )
      diff++;
  }
  return diff;
};

describe("negative generated layers in the owning context (DM-C5GEMW)", () => {
  it.each([
    [
      "beneath a non-transferred body background",
      `<style>html{background:rgb(255,255,0)}body{margin:10px;background:white;height:100px}${after("0 -20px -20px 0")}</style><div id=h></div>`,
    ],
    [
      "beneath a wrapper block background",
      `<style>body{margin:0;background:white}#w{background:rgb(0,200,255);padding:10px}${after()}</style><div id=w><div id=h></div></div>`,
    ],
    [
      "above a body background that moved to the canvas",
      `<style>body{margin:0;background:white}${after()}#h{margin:10px}</style><div id=h></div>`,
    ],
    [
      "tree order against a real negative sibling at the same z",
      `<style>body{margin:0;background:white}${after()}#r{position:absolute;left:20px;top:20px;width:60px;height:60px;background:rgb(0,0,255);z-index:-1}</style><div id=h></div><div id=r></div>`,
    ],
    [
      "host stacking context keeps its negative layer above its own background",
      `<style>body{margin:0;background:white}${after("10px")}#h{z-index:0;background:rgb(0,200,255)}</style><div id=h></div>`,
    ],
  ])(
    "%s",
    async (_name, html) => {
      expect(await diffAgainstChromium(html)).toBe(0);
    },
    60_000,
  );
});
