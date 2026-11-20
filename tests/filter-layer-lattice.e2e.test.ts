import type { Browser, Page } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, expect, it } from "vitest";
import { captureElementTree, launchChromium } from "../src/capture/index.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// A CSS filter is a SaveLayer in the filtered box's own transform space
// (core/paint/paint_property_tree_builder.cc:2453 and
// platform/graphics/compositing/paint_chunks_to_cc_layer.cc:689-743, Chromium
// 7d859f27). Under a rotation, Skia keeps only the CTM's scale as the layer
// matrix for a blur-based filter (src/core/SkImageFilterTypes.cpp:274-283,
// Skia 62efacd3), so text is rasterized on that space's pixel grid first.
// Blink paints a rotated box from its rounded paint offset, so its local grid
// does not depend on the fractional part of the layout offset: Chromium paints
// a fractional margin exactly like the rounded one. The renderer's SVG must
// put the filter's user-space grid in the same place, which makes its output
// for the two margins byte-identical too.
const W = 200,
  H = 160;
const viewport = { x: 0, y: 0, width: W, height: H };
let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(async () => closeBrowserSafely(browser), 15_000);
const rgba = async (bytes: Buffer) => sharp(bytes).ensureAlpha().raw().toBuffer();

const html = (margin: string, own: string, parent = "", height = "36px") =>
  `<style>body{margin:0;background:#fff}#b{display:flex;align-items:center;justify-content:center;width:70px;height:${height};` +
  `background:#36c;color:#fff;font-weight:bold;${own}}</style>` +
  `<div style="padding:${margin} 0 0 40px"><div style="${parent}"><div id="b">Rotate</div></div></div>`;

async function renderBoth(page: Page, output: Page, markup: string) {
  await page.setContent(markup);
  const source = await rgba(await page.screenshot({ omitBackground: true }));
  const svg = elementTreeToSvg(await captureElementTree(page, "body", viewport), W, H);
  await output.setContent(`<style>body{margin:0}</style>${svg}`);
  return { source, svg, actual: await rgba(await output.screenshot({ omitBackground: true })) };
}

it.each([
  {
    name: "a rotated box with its own drop-shadow",
    own: "filter:drop-shadow(0 5px 10px rgba(0,0,0,.6));transform:rotate(10deg)",
  },
  // A skew's layer matrix scales y by |(c, d)|, so the parameter grid has to
  // be Blink's local space itself, not merely congruent to it.
  { name: "a skewed box with its own blur", own: "filter:blur(0.5px);transform:skewX(12deg)", height: "38px" },
  {
    name: "a filtered child of a rotated box",
    own: "filter:drop-shadow(0 5px 10px rgba(0,0,0,.6))",
    parent: "transform:rotate(-25deg);width:120px",
  },
])("paints $name on Blink's layer grid at a fractional paint offset", async ({ own, parent, height }) => {
  const page = await browser.newPage({ viewport }),
    output = await browser.newPage({ viewport });
  try {
    const whole = await renderBoth(page, output, html("20px", own, parent, height));
    const fractional = await renderBoth(page, output, html("20.4375px", own, parent, height));
    // Chromium itself paints both margins identically.
    expect(fractional.source.equals(whole.source), "source").toBe(true);
    // So must the renderer.
    expect(fractional.actual.equals(whole.actual), "renderer").toBe(true);
    // Negative control: the same SVGs without the parameter-space wrapper
    // (the renderer's previous output) differ between the two margins.
    // An identity translate in their place is a no-op wrapper.
    const strip = (svg: string) =>
      svg.replace(
        /(<g[^>]*?)translate\((-?[\d.]+) (-?[\d.]+)\)("[^>]*style="filter:[^"]*">\s*<g transform=")translate\((-?[\d.]+) (-?[\d.]+)\)">/g,
        (all, head: string, x: string, y: string, middle: string, ix: string, iy: string) =>
          Number(ix) === -Number(x) && Number(iy) === -Number(y)
            ? `${head}translate(0 0)${middle}translate(0 0)">`
            : all,
      );
    const unwrapped = [strip(whole.svg), strip(fractional.svg)];
    expect(unwrapped[1]).not.toBe(fractional.svg);
    const shots = [];
    for (const svg of unwrapped) {
      await output.setContent(`<style>body{margin:0}</style>${svg}`);
      shots.push(await rgba(await output.screenshot({ omitBackground: true })));
    }
    expect(shots[1].equals(shots[0]), "unwrapped").toBe(false);
  } finally {
    await page.close();
    await output.close();
  }
});
