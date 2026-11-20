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

// Under CSS zoom Blink lays out in zoomed LayoutUnits and snaps the paint rect
// with the same ToPixelSnappedRect (core/layout/geometry/physical_rect.h:228),
// while getBoundingClientRect divides only by the frame's layout zoom factor
// under standardized zoom (AdjustRectMaybeExcludingCSSZoom,
// core/layout/adjust_for_absolute_zoom.h), so the captured rect is already in
// that zoomed space. Each case must match native Chromium byte for byte, and
// dropping the border paint snap record must not.
const zoomBox =
  "width:20px;height:20px;background:red;border:2px solid blue;outline:2px solid green;outline-offset:1px";
it.each([
  {
    name: "untransformed half-pixel box at zoom 1.25",
    html: `<div style="zoom:1.25"><div style="${zoomBox};margin:10px"></div></div>`,
  },
  {
    name: "untransformed fractional box at zoom 0.8",
    html: `<div style="zoom:0.8"><div style="${zoomBox};margin:10.4px 10.2px"></div></div>`,
  },
  {
    name: "box under nested zooms",
    html: `<div style="zoom:1.25"><div style="zoom:0.8"><div style="${zoomBox};margin:10.3px"></div></div></div>`,
  },
  {
    name: "frozen scaled box at zoom 1.25",
    html: `<div style="zoom:1.25"><div style="${zoomBox};margin:10px;transform:scale(1.5)"></div></div>`,
  },
  {
    name: "child of a fractional frozen scale at zoom 1.25",
    html: `<div style="zoom:1.25"><div style="transform:scale(1.5);margin:8.4px;width:40px"><div style="${zoomBox};margin:2.6px"></div></div></div>`,
  },
])("snaps box decorations in zoomed layout space: $name", async ({ html }) => {
  const page = await browser.newPage({ viewport }),
    output = await browser.newPage({ viewport });
  try {
    await page.setContent(`<style>body{margin:0}</style>${html}`);
    const source = await rgba(await page.screenshot({ omitBackground: true }));
    const tree = await captureElementTree(page, "body", viewport);
    await output.setContent("<style>body{margin:0}</style>" + elementTreeToSvg(tree, 100, 100));
    expect(await rgba(await output.screenshot({ omitBackground: true }))).toEqual(source);
    // Negative control: without the record the decorations paint unsnapped.
    const strip = (nodes: typeof tree) => {
      for (const node of nodes) {
        delete node.borderPaintSnap;
        strip(node.children);
      }
    };
    strip(tree);
    await output.setContent("<style>body{margin:0}</style>" + elementTreeToSvg(tree, 100, 100));
    expect(await rgba(await output.screenshot({ omitBackground: true }))).not.toEqual(source);
  } finally {
    await page.close();
    await output.close();
  }
});
