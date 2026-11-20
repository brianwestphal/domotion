import type { Browser, Page } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureElementTree, launchChromium } from "./index.js";
import { closeBrowserSafely } from "../test-support/close-browser-safely.js";
import { elementTreeToSvg } from "../render/element-tree-to-svg.js";
import { forEachElement } from "../tree-ops/for-each-element.js";
import type { CapturedElement } from "./types.js";

// DM-ESPA0W: a generated ::after with mix-blend-mode blends its own effect
// group against the backdrop inside the nearest isolated stacking context
// (Blink core/paint/paint_property_tree_builder.cc:1774-1788 and :2040,
// Chromium 7d859f27). Every case compares full RGBA pixels against Chromium;
// the negative control strips the captured mode and must reproduce the old
// opaque-purple miss wherever the blend is visible.

const W = 120;
const H = 120;
// A mid-tone backdrop: every mode moves at least one channel of the purple
// source by more than the diff tolerance, so each negative control is exact.
const backdrop = `<div style="position:absolute;left:0;top:0;width:60px;height:60px;background:rgb(40,160,220)"></div>`;
const html = (mode: string, extra = "", wrapper = "") =>
  `<style>body{margin:0;background:white}#w{${wrapper}}#h::after{content:"";display:block;width:60px;height:60px;background:rgb(128,0,128);mix-blend-mode:${mode};${extra}}</style>${backdrop}<div id=w><div id=h></div></div>`;

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
  const modes: Array<string | undefined> = [];
  forEachElement(tree, (element) => {
    for (const record of element.pseudoFragments ?? []) modes.push(record.paint.mixBlendMode);
  });
  const svg = elementTreeToSvg(tree, W, H);
  const actual = diff(expected, await render(tree));
  forEachElement(tree, (element) => {
    for (const record of element.pseudoFragments ?? []) delete record.paint.mixBlendMode;
  });
  const legacy = diff(expected, await render(tree));
  return { modes, svg, actual, legacy };
};

describe("generated pseudo mix-blend-mode (DM-ESPA0W)", () => {
  it.each([
    // Separable: per-channel functions.
    ["multiply"],
    ["screen"],
    ["overlay"],
    ["darken"],
    ["lighten"],
    ["color-dodge"],
    ["color-burn"],
    ["hard-light"],
    ["soft-light"],
    ["difference"],
    ["exclusion"],
    // Non-separable: hue/saturation/luminosity mixing.
    ["hue"],
    ["saturation"],
    ["color"],
    ["luminosity"],
  ])(
    "%s blends against the earlier positioned backdrop box",
    async (mode) => {
      const result = await compare(html(mode));
      expect(result.modes).toEqual([mode]);
      expect(result.svg).toContain(`mix-blend-mode:${mode}`);
      expect(result.actual).toBe(0);
      expect(result.legacy).toBe(3600);
    },
    60_000,
  );

  it("blends with filter and opacity on the same generated box", async () => {
    const result = await compare(html("multiply", "opacity:.8;filter:brightness(1.2)"));
    expect(result.modes).toEqual(["multiply"]);
    expect(result.actual).toBe(0);
    expect(result.legacy).toBe(3600);
  }, 60_000);

  // An overflow-clip wrapper is not an isolation boundary in Blink either, but
  // the SVG `clip-path` group that carries it isolates blending for real
  // elements and generated boxes alike; that renderer-wide gap is tracked
  // separately, so only the clip-free non-isolating wrapper is pinned here.
  it.each([["non-isolating relative z:auto", "position:relative"]])(
    "a %s wrapper is not an isolation boundary",
    async (_name, wrapper) => {
      const result = await compare(html("multiply", "", wrapper));
      expect(result.actual).toBe(0);
      expect(result.legacy).toBeGreaterThan(0);
    },
    60_000,
  );

  it.each([
    ["isolation:isolate wrapper", "isolation:isolate"],
    ["positioned z-index wrapper", "position:relative;z-index:0"],
    ["opacity wrapper", "opacity:.999"],
  ])(
    "%s isolates the blend from the backdrop box outside it",
    async (_name, wrapper) => {
      const result = await compare(html("multiply", "", wrapper));
      expect(result.modes).toEqual(["multiply"]);
      expect(result.actual).toBe(0);
      // Inside the isolated group the backdrop is transparent, so the blend
      // reduces to source-over and the stripped tree paints the same pixels.
      expect(result.legacy).toBe(0);
    },
    60_000,
  );

  it("blends with its isolated host background but not past the isolation boundary", async () => {
    const result = await compare(html("multiply", "", "isolation:isolate;background:rgb(255,255,0)"));
    expect(result.actual).toBe(0);
    // Purple multiplied by yellow is red over the whole 60x60 box.
    expect(result.legacy).toBe(3600);
  }, 60_000);

  it("normal mode stays unstyled", async () => {
    const result = await compare(html("normal"));
    expect(result.modes).toEqual(["normal"]);
    expect(result.svg).not.toContain("mix-blend-mode");
    expect(result.actual).toBe(0);
    expect(result.legacy).toBe(0);
  }, 60_000);
});
