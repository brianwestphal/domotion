import type { Browser, Page } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureElementTree, launchChromium } from "./index.js";
import { closeBrowserSafely } from "../test-support/close-browser-safely.js";
import { elementTreeToSvg } from "../render/element-tree-to-svg.js";

// DM-8F20GA: linear/radial gradient background layers tile by
// background-size/position/repeat across the painting area, as Blink tiles any
// generated image. Each case is compared full-RGBA against Chromium (channel
// tolerance 8 for gradient interpolation rounding).

const W = 140;
const H = 140;
const div = (background: string, extra = "") =>
  `<style>body{margin:0;background:white}div{margin:10px;width:100px;height:100px;background:${background};${extra}}</style><div></div>`;

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
    let d = 0;
    for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(expected[i + c] - actual[i + c]));
    if (d > 8) diff++;
  }
  return diff;
};

const linear = "linear-gradient(rgb(0,200,255),rgb(255,255,0))";
const radial = "radial-gradient(circle,rgb(255,0,0) 40%,rgb(0,0,255) 41%)";

describe("gradient background tiling (DM-8F20GA)", () => {
  it.each([
    ["linear, two 50px rows", div(`${linear} 0 0/100px 50px`)],
    ["radial, 25px tiles offset 5px", div(`${radial} 5px 5px/25px 25px`)],
    ["linear, repeat-x only", div(`${linear} 0 0/30px 40px repeat-x`)],
    ["radial, no-repeat centered", div(`${radial} center/40px 40px no-repeat`)],
    ["linear, space", div(`${linear} 0 0/30px 30px space`)],
    ["radial, round", div(`${radial} 0 0/30px 30px round`)],
    ["repeating-linear tile", div("repeating-linear-gradient(45deg,red 0 5px,blue 5px 10px) 0 0/40px 40px")],
    ["auto size repeats into the border area", div(linear, "border:10px dashed transparent")],
    ["percentage size", div(`${linear} 0 0/50% 25%`)],
    ["control: auto size fills the box", div(linear)],
    ["control: radial auto size", div(radial)],
  ])(
    "%s",
    async (_name, html) => {
      expect(await diffAgainstChromium(html)).toBe(0);
    },
    60_000,
  );
});
