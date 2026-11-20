import type { Browser, Page } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureElementTree, launchChromium } from "./index.js";
import { closeBrowserSafely } from "../test-support/close-browser-safely.js";
import { elementTreeToSvg } from "../render/element-tree-to-svg.js";

// DM-T0CE2X: a non-positioned stacking context nested in static wrappers is
// collected into the root z-order list (z 0, tree order), so it paints over an
// EARLIER positioned z:auto sibling. Before the hoist each case below differed
// by the whole 60x60 overlap (3600 px).

const W = 120;
const H = 120;
const blue = `<div style="position:absolute;left:0;top:0;width:60px;height:60px;background:rgb(0,0,255)"></div>`;
const item = (style: string) =>
  `<i style="display:block;width:60px;height:60px;background:rgb(128,0,128);${style}"></i>`;

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
  await page.setContent(`<style>body{margin:0;background:white}</style>${html}`);
  const expected = await rgbaPixels(await page.screenshot());
  const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: W, height: H });
  await generated.setContent(`<style>html,body{margin:0;background:white}</style>${elementTreeToSvg(tree, W, H)}`);
  const actual = await rgbaPixels(await generated.screenshot());
  let diff = 0;
  for (let i = 0; i < expected.length; i += 4) {
    let d = 0;
    for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(expected[i + c] - actual[i + c]));
    if (d > 2) diff++;
  }
  return diff;
};

describe("non-positioned stacking contexts in the z-order list (DM-T0CE2X)", () => {
  it.each([
    ["opacity", `${blue}<div>${item("opacity:.99")}</div>`],
    ["transform", `${blue}<div>${item("transform:translateX(0)")}</div>`],
    ["filter", `${blue}<div>${item("filter:blur(0)")}</div>`],
    ["isolation", `${blue}<div>${item("isolation:isolate")}</div>`],
    ["will-change", `${blue}<div>${item("will-change:opacity")}</div>`],
    ["contain:paint", `${blue}<div>${item("contain:paint")}</div>`],
    ["two static wrappers", `${blue}<div><div>${item("opacity:.99")}</div></div>`],
    ["through an overflow:hidden wrapper", `${blue}<div style="overflow:hidden">${item("opacity:.99")}</div>`],
    ["z-index that does not apply", `${blue}<div>${item("opacity:.99;z-index:-1")}</div>`],
    ["control: plain block stays in flow", `${blue}<div>${item("")}</div>`],
    ["control: later flow block", `<div>${item("opacity:.99")}</div><div style="margin-top:-60px">${item("")}</div>`],
  ])(
    "%s",
    async (_name, html) => {
      expect(await diffAgainstChromium(html)).toBe(0);
    },
    60_000,
  );
});
