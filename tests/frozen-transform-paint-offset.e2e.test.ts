import type { Browser } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, expect, it } from "vitest";
import { captureElementTree, launchChromium } from "../src/capture/index.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// A transformed box gets a PaintOffsetTranslation of its ROUNDED paint offset
// (ToRoundedVector2d, Chromium 7d859f27 core/paint/paint_property_tree_builder.cc
// :748), and its transform origin is resolved from the box's local rect
// (ComputeReferenceBox -> fragment.LocalRect(), core/layout/transform_utils.cc
// :38-40). On an axis whose transform is not a translation the subpixel
// accumulation is dropped (CanPropagateSubpixelAccumulation, :652-686), so the
// box and its subtree paint round(P) - P further along before the transform.
// The capture folds that shift into the frozen transform's matrix and snaps
// borders, outlines and shadows in the resulting local space. Full RGBA must
// match native Chromium exactly.
const viewport = { x: 0, y: 0, width: 100, height: 100 };
let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(async () => closeBrowserSafely(browser), 15_000);
const rgba = async (bytes: Buffer) => sharp(bytes).ensureAlpha().raw().toBuffer();

it.each([
  { name: "fractional scaled background", own: "background:red;margin:20.5px;transform:scale(1.5)" },
  { name: "fractional rotated background", own: "background:red;margin:20.5px;transform:rotate(10deg)" },
  { name: "fractional scaled shadow", own: "box-shadow:4px 0 0 red;margin:20.5px;transform:scale(1.5)" },
  { name: "fractional scaled border", own: "border:2px solid blue;margin:20.5px;transform:scale(1.5)" },
  { name: "fractional scaled outline", own: "outline:2px solid blue;margin:20.5px;transform:scale(1.5)" },
  {
    name: "fractional rotated rounded border",
    own: "border:3px solid blue;border-radius:6px;margin:20.5px;transform:rotate(10deg)",
  },
  { name: "fractional scaled double border", own: "border:6px double blue;margin:20.5px;transform:scale(1.5)" },
  {
    name: "composited scale (will-change)",
    own: "background:red;border:2px solid blue;margin:20.5px;transform:scale(1.5);will-change:transform",
  },
  {
    name: "paint-isolated scale",
    own: "background:red;border:2px solid blue;margin:20.5px;transform:scale(1.5);contain:paint",
  },
  {
    name: "border of a child under a fractional scaled parent",
    own: "border:2px solid blue;margin:3.25px",
    parent: "transform:scale(1.5);margin:10.5px;width:40px",
  },
  {
    name: "integral scaled control",
    own: "background:red;border:2px solid blue;margin:20px;transform:scale(1.5)",
  },
])("matches native pixels for a $name", async (sample) => {
  const page = await browser.newPage({ viewport }),
    output = await browser.newPage({ viewport });
  try {
    await page.setContent(
      `<style>body{margin:0}#only{width:20px;height:20px;${sample.own}}</style><div id="parent" style="${"parent" in sample ? sample.parent : ""}"><div id="only"></div></div>`,
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
