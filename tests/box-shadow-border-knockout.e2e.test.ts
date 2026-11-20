import type { Browser } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, expect, it } from "vitest";
import { captureElementTree, launchChromium } from "../src/capture/index.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import { retainNativeShadowSource } from "./native-shadow-evidence.js";
const viewport = { x: 0, y: 0, width: 100, height: 100 };
let browser: Browser;
let priorProbe: string | undefined;
beforeAll(async () => {
  priorProbe = process.env["DOMOTION_GENERIC_PROBE"];
  process.env["DOMOTION_GENERIC_PROBE"] = "0";
  browser = await launchChromium();
});
afterAll(async () => {
  await closeBrowserSafely(browser);
  if (priorProbe == null) delete process.env["DOMOTION_GENERIC_PROBE"];
  else process.env["DOMOTION_GENERIC_PROBE"] = priorProbe;
});
const rgba = async (bytes: Buffer) => sharp(bytes).ensureAlpha().raw().toBuffer();
const cases = [
  { name: "original zero-origin root", shadow: "4px 4px 0 red", extra: "margin:0" },
  { name: "transparent shifted box", shadow: "4px 4px 0 red" },
  {
    name: "semitransparent background",
    shadow: "4px 4px 0 red",
    extra: "background:rgba(0,0,255,.5)",
    ownsOtherRootPaint: true,
  },
  { name: "opaque path preserved", shadow: "4px 4px 0 red", extra: "background:blue", ownsOtherRootPaint: true },
  { name: "positive spread", shadow: "0 0 0 4px red" },
  { name: "negative spread", shadow: "4px 4px 0 -2px red" },
  { name: "rounded native coverage", shadow: "4px 4px 0 red", extra: "border-radius:5px" },
  { name: "group opacity", shadow: "4px 4px 0 red", extra: "opacity:.5" },
  { name: "translucent rounded shadow", shadow: "4px 4px 0 rgba(255,0,0,.5)", extra: "border-radius:5px" },
  { name: "multiple normal layers", shadow: "4px 4px 0 red,-4px -4px 0 blue" },
  { name: "mixed inset and normal layers", shadow: "inset 0 0 0 3px blue,4px 4px 0 red" },
  { name: "fractional source shadow offset", shadow: "4.5px 4.5px 0 red" },
  {
    name: "transparent border",
    shadow: "4px 4px 0 red",
    extra: "border:2px solid transparent",
    ownsOtherRootPaint: true,
  },
  { name: "zero offset paints nothing inside", shadow: "0 0 0 red" },
  {
    name: "coincident opaque source preserves native edge coverage",
    shadow: "0 0 0 red",
    extra: "border-radius:5px;background:blue",
    ownsOtherRootPaint: true,
  },
  {
    name: "coincident semitransparent source has no shadow halo",
    shadow: "0 0 0 red",
    extra: "border-radius:5px;background:rgba(0,0,255,.5)",
    ownsOtherRootPaint: true,
  },
  { name: "coincident circular contour is empty", shadow: "0 0 0 red", extra: "border-radius:5px" },
  { name: "coincident elliptical contour is empty", shadow: "0 0 0 red", extra: "border-radius:8px / 4px" },
  { name: "coincident unequal contour is empty", shadow: "0 0 0 red", extra: "border-radius:8px 0 3px 5px" },
  {
    name: "fractional coincident circular contour is empty",
    shadow: "0 0 0 red",
    extra: "border-radius:5px;position:absolute;left:20.5px;top:20.5px;margin:0",
  },
  { name: "horizontal circular offset", shadow: "4px 0 0 red", extra: "border-radius:5px" },
  { name: "vertical circular offset", shadow: "0 4px 0 red", extra: "border-radius:5px" },
  { name: "circular negative spread", shadow: "0 0 0 -2px red", extra: "border-radius:5px" },
  { name: "circular positive spread", shadow: "0 0 0 2px red", extra: "border-radius:5px" },
  // PaintNormalBoxShadow paints from PixelSnappedContouredBorder: a
  // fractional source rect paints its shadow and knockout on whole pixels.
  { name: "fractional rounded source origin", shadow: "4px 0 0 red", extra: "border-radius:5px;margin:20.5px" },
  { name: "fractional sharp source origin", shadow: "4px 0 0 red", extra: "margin:20.5px" },
  { name: "fractional source width", shadow: "4px 0 0 red", extra: "width:20.5px" },
  {
    name: "quarter-pixel rounded source origin",
    shadow: "4px 3px 0 red",
    extra: "border-radius:5px;margin:20.25px 20.75px",
  },
  { name: "fractional origin with spread", shadow: "0 0 0 2px red", extra: "border-radius:5px;margin:20.5px" },
  // PaintInsetBoxShadowWithBorderRect clips to PixelSnappedContouredInnerBorder:
  // the same local snap, inset by integer border widths.
  { name: "fractional sharp inset", shadow: "inset 0 0 0 3px red", extra: "margin:20.5px" },
  { name: "fractional rounded inset", shadow: "inset 0 0 0 3px red", extra: "margin:20.5px;border-radius:5px" },
  { name: "fractional inset width", shadow: "inset 0 0 0 3px red", extra: "width:20.5px" },
  {
    name: "quarter-pixel offset inset",
    shadow: "inset 0 -3px 0 red",
    extra: "margin:20.25px 20.75px;border-radius:4px",
  },
  {
    name: "fractional bordered inset",
    shadow: "inset 2px 3px 0 1px red",
    extra: "margin:20.5px;border:2px solid rgba(0,0,255,.5);border-radius:6px",
    ownsOtherRootPaint: true,
  },
  // A fractional spread puts the shadow shape on quarter/eighth-pixel edges;
  // the shape must keep those digits (one decimal moved 20.125 to 20.1).
  { name: "fractional negative circular spread", shadow: "0 0 0 -.125px red", extra: "border-radius:5px" },
  { name: "fractional positive circular spread", shadow: "0 0 0 .375px red", extra: "border-radius:5px" },
  {
    name: "fractional negative spread under a translucent background",
    shadow: "0 0 0 -.125px red",
    extra: "border-radius:5px;background:rgba(0,0,255,.5)",
    ownsOtherRootPaint: true,
  },
  // A sharp box's knockout is ClipOut(RectF), a non-antialiased difference
  // clip (graphics_context.h:384-386, Chromium 7d859f27): Skia rounds its
  // DEVICE rect (SkRasterClip.cpp:170-171, Skia 62efacd3) and fills the shadow
  // rect once per clip-region rectangle (SkScan_Antihair.cpp:784-808), so a
  // half-pixel row that starts a region band paints one level lower.
  {
    name: "own half-pixel translate, sharp",
    shadow: "4px 0 0 red",
    extra: "margin:20.5px;transform:translate(.5px,.5px)",
  },
  { name: "ancestor half-pixel translate, sharp", shadow: "4px 0 0 red", wrap: "transform:translate(.5px,.5px)" },
  { name: "half-pixel row starting a clip band", shadow: "30.5px .5px 0 red" },
  {
    name: "half-pixel row starting a clip band, opaque",
    shadow: "30.5px .5px 0 red",
    extra: "background:blue",
    ownsOtherRootPaint: true,
  },
  {
    name: "own half-pixel translate, opaque sharp",
    shadow: "4px 0 0 red",
    extra: "margin:20.5px;background:blue;transform:translate(.5px,.5px)",
    ownsOtherRootPaint: true,
  },
  {
    name: "quarter-pixel translate with spread",
    shadow: "3px 2px 0 1px red",
    extra: "margin:20.25px;transform:translate(.25px,.75px)",
  },
  {
    name: "translucent layers under a half-pixel translate",
    shadow: "4px 3px 0 rgba(255,0,0,.5),-3.5px 0 0 green",
    extra: "margin:20.5px;background:rgba(0,0,255,.5);transform:translate(.5px,.5px)",
    ownsOtherRootPaint: true,
  },
  // The sharp inset clip is context.Clip(RectF), non-antialiased as well, and
  // the hole is cut from AreaCastingShadowInHole (box_painter_base.cc:509-576).
  {
    name: "own half-pixel translate, sharp inset",
    shadow: "inset 0 0 0 3px red",
    extra: "margin:20.5px;transform:translate(.5px,.5px)",
  },
  {
    name: "ancestor half-pixel translate, sharp inset",
    shadow: "inset 0 0 0 3px red",
    wrap: "transform:translate(.5px,.5px)",
  },
  {
    name: "offset inset under a quarter-pixel translate",
    shadow: "inset 2px -3px 0 1px red",
    extra: "margin:20.25px 20.75px;transform:translate(.25px,.5px)",
  },
  {
    name: "mixed inset and normal layers under a half-pixel translate",
    shadow: "inset 0 0 0 3px blue,4px 4px 0 red,-3.5px 0 0 green",
    extra: "margin:20.5px;transform:translate(.5px,.5px)",
  },
];
it.each(cases)(
  "matches complete native pixels for $name",
  async (sample) => {
    const page = await browser.newPage({ viewport }),
      output = await browser.newPage({ viewport });
    try {
      const fixtureHtml = `<style>body{margin:0}#only{display:block;width:20px;height:20px;margin:20px;border:0;background:transparent;box-shadow:${sample.shadow};${sample.extra ?? ""}}</style><div id="container" style="${"wrap" in sample ? sample.wrap : ""}"><div id="only"></div></div>`;
      await page.setContent(fixtureHtml);
      const sourcePng = await page.screenshot({ omitBackground: true });
      const witness =
        sample.name === "original zero-origin root"
          ? retainNativeShadowSource({
              id: "j2-original-knockout",
              label: sample.name,
              fixtureFile: import.meta.url,
              fixtureHtml,
              browserVersion: browser.version(),
              viewport,
              sourcePng,
            })
          : undefined;
      const source = await rgba(sourcePng);
      // A shadow-only selected root is admitted at an integral, untransformed
      // paint space (DM-9B7A6G) and must then match the same native pixels;
      // a fractional or translated one stays refused, while the container,
      // body and owned-background roots keep their complete assertions.
      const owns = "ownsOtherRootPaint" in sample && sample.ownsOtherRootPaint;
      const directShadowRoot = !/(?:margin|width|left|top):[^;]*\.\d|translate/.test(
        `${sample.extra ?? ""}${"wrap" in sample ? sample.wrap : ""}`,
      );
      if (!owns && !directShadowRoot) {
        expect(await captureElementTree(page, "#only", viewport)).toEqual([]);
      }
      for (const selector of owns || directShadowRoot ? ["#only", "#container", "body"] : ["#container", "body"]) {
        const captured = await captureElementTree(page, selector, viewport);
        expect(captured, selector).toHaveLength(1);
        await output.setContent("<style>body{margin:0}</style>" + elementTreeToSvg(captured, 100, 100));
        const outputPng = await output.screenshot({ omitBackground: true });
        witness?.output(selector, outputPng);
        expect(await rgba(outputPng), selector).toEqual(source);
      }
    } finally {
      await page.close();
      await output.close();
    }
  },
  30000,
);

it.each(["border-radius:5px;corner-shape:bevel", "border-radius:50%;corner-shape:squircle"])(
  "retains the selected-root boundary for a non-round corner-shape contour: %s",
  async (extra) => {
    const page = await browser.newPage({ viewport });
    try {
      await page.setContent(
        `<style>body{margin:0}#only{width:20px;height:20px;margin:20px;box-shadow:4px 4px 0 red;${extra}}</style><div id="only"></div>`,
      );
      expect(await captureElementTree(page, "#only", viewport)).toEqual([]);
    } finally {
      await page.close();
    }
  },
);

it("knocks out the complete source interior after blur while blurred-root admission stays held", async () => {
  const page = await browser.newPage({ viewport }),
    output = await browser.newPage({ viewport });
  try {
    await page.setContent(
      '<style>body{margin:0}#only{width:20px;height:20px;margin:20px;background:transparent;box-shadow:4px 4px 4px red}</style><div id="container"><div id="only"></div></div>',
    );
    const source = await sharp(await page.screenshot({ omitBackground: true }))
      .extract({ left: 20, top: 20, width: 20, height: 20 })
      .ensureAlpha()
      .raw()
      .toBuffer();
    expect(await captureElementTree(page, "#only", viewport)).toEqual([]);
    const tree = await captureElementTree(page, "#container", viewport);
    await output.setContent("<style>body{margin:0}</style>" + elementTreeToSvg(tree, 100, 100));
    const actual = await sharp(await output.screenshot({ omitBackground: true }))
      .extract({ left: 20, top: 20, width: 20, height: 20 })
      .ensureAlpha()
      .raw()
      .toBuffer();
    expect(actual).toEqual(source);
    expect(actual.equals(Buffer.alloc(20 * 20 * 4))).toBe(true);
    // DM-RRWR8E retains the independently measured outer alpha-kernel mismatch;
    // this contract claims exact interior clipping, never full blur parity.
  } finally {
    await page.close();
    await output.close();
  }
});

it("keeps a display:contents selector transparent and captures its real child", async () => {
  const page = await browser.newPage({ viewport });
  const output = await browser.newPage({ viewport });
  try {
    await page.setContent(
      '<style>body{margin:0}#only{display:contents;box-shadow:0 0 0 4px blue}#paint{width:20px;height:20px;margin:20px;background:red}</style><div id="container"><div id="only"><div id="paint"></div></div></div>',
    );
    const source = await rgba(await page.screenshot({ omitBackground: true }));
    for (const selector of ["#only", "#container", "body"]) {
      const tree = await captureElementTree(page, selector, viewport);
      if (selector === "#only") expect(tree.map((node) => node.styles.backgroundColor)).toEqual(["rgb(255, 0, 0)"]);
      await output.setContent("<style>body{margin:0}</style>" + elementTreeToSvg(tree, 100, 100));
      expect(await rgba(await output.screenshot({ omitBackground: true })), selector).toEqual(source);
    }
  } finally {
    await page.close();
    await output.close();
  }
});

// Rounded shadows, full RGBA:
// - ApplySpreadToShadowShape (box_painter_base.cc:91-97, Chromium 7d859f27)
//   grows a radius smaller than the spread by the coverage-factor correction.
// - Blink draws a rounded box's shadow under the antialiased
//   ClipOutContouredRect (ClipToBorderEdge, :175-198; inset 1px on an opaque
//   background). Under an AA clip Skia's CPU rasterizer accumulates path
//   coverage run by run (SkScan::AntiFillPath forceRLE, Skia 62efacd3
//   SkScan_AntiPath.cpp:145-153), so the shape and the knockout contour are
//   drawn under AA clips too.
// - Four equal elliptical corners are an SVG <rect rx ry>, the same convex
//   SkRRect. Unequal corners are a pixel-aligned rect under a CSS inset()
//   clip: BasicShapeInset::GetPath builds that SkRRect (basic_shapes.cc:
//   349-379), and Skia rasterizes it as an AA clip with the same run-based
//   accumulator. Path arcs are float-computed conics and do not match.
it.each([
  { name: "small radius, larger spread", css: "box-shadow:0 0 0 4px red;border-radius:2px" },
  { name: "offset with a large spread", css: "box-shadow:3px 2px 0 8px red;border-radius:1px" },
  { name: "three times the radius", css: "box-shadow:0 0 0 10px red;border-radius:3px" },
  { name: "unequal corners with spread", css: "box-shadow:0 0 0 5px red;border-radius:2px 0 4px 8px" },
  { name: "unequal corners with a large spread", css: "box-shadow:0 0 0 12px red;border-radius:2px 0 4px 8px" },
  {
    name: "unequal corners with a large spread at a half pixel",
    css: "box-shadow:0 0 0 12px red;border-radius:2px 0 4px 8px;margin:20.5px",
  },
  {
    name: "unequal corners with a fractional offset and spread",
    css: "box-shadow:3.5px 2.25px 0 7px red;border-radius:3px 9px 1px 5px",
  },
  {
    name: "unequal fractional corners on an opaque box",
    css: "box-shadow:4px 4px 0 red;border-radius:8.3px 0 3.7px 5px;background:blue",
  },
  { name: "half-pixel horizontal offset", css: "box-shadow:.5px 0 0 red;border-radius:5px" },
  { name: "half-pixel vertical offset", css: "box-shadow:0 .5px 0 red;border-radius:5px" },
  { name: "elliptical corners", css: "box-shadow:4px 4px 0 red;border-radius:8px / 4px" },
  { name: "unequal corners", css: "box-shadow:4px 4px 0 red;border-radius:8px 0 3px 5px" },
  { name: "elliptical corners with spread", css: "box-shadow:0 0 0 6px red;border-radius:3px / 1px" },
  { name: "opaque elliptical box", css: "box-shadow:4px 4px 0 red;border-radius:8px / 4px;background:blue" },
  { name: "opaque box at a half pixel", css: "box-shadow:.5px 0 0 red;border-radius:5px;background:blue" },
  { name: "opaque blurred box", css: "box-shadow:4px 4px 4px red;border-radius:5px;background:blue" },
])("matches native rounded shadow coverage: $name", async ({ css }) => {
  const page = await browser.newPage({ viewport }),
    output = await browser.newPage({ viewport });
  try {
    await page.setContent(
      `<style>body{margin:0}#only{width:20px;height:20px;margin:20px;${css}}</style><div id="container"><div id="only"></div></div>`,
    );
    const source = await rgba(await page.screenshot({ omitBackground: true }));
    await output.setContent(
      "<style>body{margin:0}</style>" +
        elementTreeToSvg(await captureElementTree(page, "#container", viewport), 100, 100),
    );
    expect(await rgba(await output.screenshot({ omitBackground: true }))).toEqual(source);
  } finally {
    await page.close();
    await output.close();
  }
});

// Negative control: the same SkRRect written as path arcs (the previous
// construction) does not reproduce native coverage, so the inset() clip is
// what makes the unequal-corner cases above exact.
it("does not match native unequal-corner coverage with path arcs", async () => {
  const page = await browser.newPage({ viewport }),
    output = await browser.newPage({ viewport });
  try {
    await page.setContent(
      '<style>body{margin:0}#only{width:20px;height:20px;margin:20px;box-shadow:0 0 0 12px red;border-radius:2px 0 4px 8px}</style><div id="container"><div id="only"></div></div>',
    );
    const source = await rgba(await page.screenshot({ omitBackground: true }));
    const svg = elementTreeToSvg(await captureElementTree(page, "#container", viewport), 100, 100);
    const inset =
      /<rect x="7" y="7" width="46" height="46" (fill="[^"]+") style="clip-path:inset\([^"]+\) fill-box" \/>/;
    expect(svg).toMatch(inset);
    const arcs = svg.replace(
      inset,
      '<clipPath id="neg" clipPathUnits="userSpaceOnUse"><rect x="6" y="6" width="48" height="48" rx="1"/></clipPath>' +
        '<path d="M15.111,8 L52,8 L52,39.328 A12.672,12.672 0 0 1 39.328,52 L27.783,52 A19.783,19.783 0 0 1 8,32.217 L8,15.111 A7.111,7.111 0 0 1 15.111,8 Z" $1 clip-path="url(#neg)" />',
    );
    await output.setContent("<style>body{margin:0}</style>" + arcs);
    expect(await rgba(await output.screenshot({ omitBackground: true }))).not.toEqual(source);
  } finally {
    await page.close();
    await output.close();
  }
});

// Blink snaps the border rect in LOCAL paint space and applies a pure
// translation afterwards (subpixel accumulation, paint_property_tree_builder.cc
// :733-779, Chromium 7d859f27), so the snap is computed before the captured
// viewport rect's translation. Spaces the capture cannot authenticate keep the
// captured geometry (no record).
it.each([
  { name: "untransformed half-pixel origin", extra: "margin:20.5px", wrap: "", snap: [0.5, 0.5, 0.5, 0.5] },
  { name: "fractional width", extra: "width:20.5px", wrap: "", snap: [0, 0, 0.5, 0] },
  { name: "integral origin", extra: "", wrap: "", snap: [0, 0, 0, 0] },
  {
    name: "own half-pixel translate",
    extra: "margin:20.5px;transform:translate(.5px,.5px)",
    wrap: "",
    snap: [0.5, 0.5, 0.5, 0.5],
  },
  {
    name: "ancestor half-pixel translate over an integral origin",
    extra: "",
    wrap: "transform:translate(.5px,.5px)",
    snap: [0, 0, 0, 0],
  },
  {
    name: "standalone translate property",
    extra: "margin:20.5px;translate:.25px",
    wrap: "",
    snap: [0.5, 0.5, 0.5, 0.5],
  },
  // A static transform is frozen (captured untransformed, re-applied as a
  // wrapper). Under a scale Blink drops the subpixel accumulation, so the box
  // paints at local 0 of its rounded paint-offset translation (the rounding is
  // folded into the wrapper matrix) and its own edges need no further snap.
  { name: "own scale transform", extra: "margin:20.5px;transform:scale(2)", wrap: "", snap: [0, 0, 0, 0] },
  { name: "rotated live ancestor", extra: "margin:20.5px", wrap: "transform:rotate(10deg)", snap: null },
  // Below such a transform descendants snap relative to its box: #mid sits at
  // x 0 / y 20.5 (the child's top margin collapses through it), so the child's
  // local x is 20.5 and its local y is 0. A frozen pure translation keeps the
  // accumulation instead.
  {
    name: "frozen scaled ancestor",
    extra: "margin:20.5px",
    wrap: "",
    mid: "transform:scale(1.5)",
    snap: [0.5, 0, 0.5, 0],
  },
  {
    name: "frozen rotated ancestor",
    extra: "margin:20.5px",
    wrap: "",
    mid: "transform:rotate(10deg)",
    snap: [0.5, 0, 0.5, 0],
  },
  {
    name: "frozen translated ancestor",
    extra: "margin:20.5px",
    wrap: "",
    mid: "transform:translate(.5px,.25px)",
    snap: [0.5, 0.5, 0.5, 0.5],
  },
  // Under CSS zoom the captured rect and Blink's layout are both zoomed px;
  // computed translations are unzoomed, so a live one is scaled by the
  // translating element's effective zoom (.4px x 1.25 = .5px).
  { name: "zoomed half-pixel origin", extra: "margin:10px", wrap: "zoom:1.25", snap: [0.5, 0.5, 0.5, 0.5] },
  {
    name: "zoom 0.8 LayoutUnit origin",
    extra: "margin:10.4px",
    wrap: "zoom:0.8",
    snap: [-0.3125, -0.3125, -0.3125, -0.3125],
  },
  {
    name: "live translated ancestor under zoom",
    extra: "margin:10px",
    wrap: "zoom:1.25",
    mid: "transition:transform 100s;transform:translate(.4px,.2px)",
    snap: [0.5, 0.5, 0.5, 0.5],
  },
  // Eligible paint isolation is authenticated: the box rounds its own paint
  // offset (shift +0.5, local origin 0), and below an isolating ancestor the
  // child snaps from that ancestor's origin (local 20.5).
  { name: "paint containment", extra: "margin:20.5px;contain:paint", wrap: "", snap: [0.5, 0.5, 0.5, 0.5] },
  { name: "isolating ancestor", extra: "margin:20.5px", wrap: "contain:paint", snap: [0.5, 0.5, 0.5, 0.5] },
  { name: "sticky position", extra: "margin:20.5px;position:sticky;top:0", wrap: "", snap: null },
  { name: "will-change transform", extra: "margin:20.5px;will-change:transform", wrap: "", snap: null },
  { name: "own percentage translate", extra: "margin:20.5px;translate:2.5%", wrap: "", snap: [0.5, 0.5, 0.5, 0.5] },
])("records the source-owned border paint snap: $name", async (sample) => {
  const { extra, wrap, snap } = sample;
  const mid = "mid" in sample ? sample.mid : "";
  const page = await browser.newPage({ viewport });
  try {
    await page.setContent(
      `<style>body{margin:0}#only{width:20px;height:20px;margin:20px;box-shadow:4px 0 0 red;${extra}}</style><div id="container" style="${wrap}"><div id="mid" style="${mid}"><div id="only"></div></div></div>`,
    );
    const tree = await captureElementTree(page, "#container", viewport);
    const find = (nodes: typeof tree): (typeof tree)[number] | undefined => {
      for (const node of nodes) {
        if (node.styles.boxShadow != null && node.styles.boxShadow !== "none") return node;
        const found = find(node.children ?? []);
        if (found != null) return found;
      }
      return undefined;
    };
    const record = find(tree)?.borderPaintSnap;
    if (snap == null) expect(record).toBeUndefined();
    else expect(record && [record.left, record.top, record.right, record.bottom]).toEqual(snap);
  } finally {
    await page.close();
  }
});

// The renderer places Blink's non-antialiased sharp-shadow clips on device
// pixels from the user→device translation the capture records: the frozen pure
// translations re-applied around the box. Any other re-applied transform
// leaves it unknown, and the renderer keeps the antialiased producer.
it.each([
  { name: "untransformed", extra: "margin:20.5px", wrap: "", mid: "", device: { x: 0, y: 0 } },
  {
    name: "own frozen translate",
    extra: "transform:translate(.5px,.25px)",
    wrap: "",
    mid: "",
    device: { x: 0.5, y: 0.25 },
  },
  { name: "live root translate", extra: "", wrap: "transform:translate(.5px,.5px)", mid: "", device: { x: 0, y: 0 } },
  {
    name: "frozen translated ancestor",
    extra: "",
    wrap: "",
    mid: "transform:translate(.75px,1.5px)",
    device: { x: 0.75, y: 0.5 },
  },
  {
    name: "own and ancestor translations add",
    extra: "transform:translate(.5px)",
    wrap: "",
    mid: "transform:translate(.75px)",
    device: { x: 0.25, y: 0 },
  },
  { name: "frozen scaled ancestor", extra: "margin:20.5px", wrap: "", mid: "transform:scale(1.5)", device: undefined },
  { name: "own scale", extra: "margin:20.5px;transform:scale(2)", wrap: "", mid: "", device: undefined },
])("records the device translation of a snapped shadow box: $name", async ({ extra, wrap, mid, device }) => {
  const page = await browser.newPage({ viewport });
  try {
    await page.setContent(
      `<style>body{margin:0}#only{width:20px;height:20px;margin:20px;box-shadow:4px 0 0 red;${extra}}</style><div id="container" style="${wrap}"><div id="mid" style="${mid}"><div id="only"></div></div></div>`,
    );
    const tree = await captureElementTree(page, "#container", viewport);
    const find = (nodes: typeof tree): (typeof tree)[number] | undefined => {
      for (const node of nodes) {
        if (node.styles.boxShadow != null && node.styles.boxShadow !== "none") return node;
        const found = find(node.children ?? []);
        if (found != null) return found;
      }
      return undefined;
    };
    const record = find(tree)?.borderPaintSnap;
    expect(record).toBeDefined();
    expect(record?.device).toEqual(device);
  } finally {
    await page.close();
  }
});

// Negative control: without the device record the same capture renders through
// the antialiased even-odd clip and the native pixels move.
it.each([
  { name: "sharp", shadow: "4px 0 0 red" },
  { name: "sharp inset", shadow: "inset 0 0 0 3px red" },
])("needs the device record to match a translated $name shadow", async ({ shadow }) => {
  const page = await browser.newPage({ viewport }),
    output = await browser.newPage({ viewport });
  try {
    await page.setContent(
      `<style>body{margin:0}#only{width:20px;height:20px;margin:20.5px;box-shadow:${shadow};transform:translate(.5px,.5px)}</style><div id="container"><div id="only"></div></div>`,
    );
    const source = await rgba(await page.screenshot({ omitBackground: true }));
    const tree = await captureElementTree(page, "#container", viewport);
    const render = async (nodes: typeof tree) => {
      await output.setContent("<style>body{margin:0}</style>" + elementTreeToSvg(nodes, 100, 100));
      return rgba(await output.screenshot({ omitBackground: true }));
    };
    expect(await render(tree)).toEqual(source);
    const strip = (nodes: typeof tree): typeof tree =>
      nodes.map((node) => ({
        ...node,
        ...(node.borderPaintSnap == null ? {} : { borderPaintSnap: { ...node.borderPaintSnap, device: undefined } }),
        children: strip(node.children ?? []),
      }));
    expect((await render(strip(tree))).equals(source)).toBe(false);
  } finally {
    await page.close();
    await output.close();
  }
});

// A blurred sharp shadow is a mask-filter blit that the region clip does not
// split; its knockout still rounds to device pixels (columns and rows 22..41
// here, the box covering 21.5..41.5). Blur kernel parity stays out of scope.
it("knocks out the device-rounded interior of a blurred shadow under a half-pixel translate", async () => {
  const page = await browser.newPage({ viewport }),
    output = await browser.newPage({ viewport });
  const alphas = async (png: Buffer) => {
    const raw = await rgba(png);
    const at = (x: number, y: number) => raw[(y * 100 + x) * 4 + 3];
    const rows: number[][] = [];
    for (let y = 21; y <= 42; y++) rows.push(Array.from({ length: 22 }, (_, i) => at(21 + i, y)));
    return rows;
  };
  try {
    await page.setContent(
      '<style>body{margin:0}#only{width:20px;height:20px;margin:20.5px;box-shadow:4px 4px 4px red;transform:translate(.5px,.5px)}</style><div id="container"><div id="only"></div></div>',
    );
    const source = await alphas(await page.screenshot({ omitBackground: true }));
    await output.setContent(
      "<style>body{margin:0}</style>" +
        elementTreeToSvg(await captureElementTree(page, "#container", viewport), 100, 100),
    );
    const actual = await alphas(await output.screenshot({ omitBackground: true }));
    // The knocked-out interior (device 22..41) is exact and empty on both.
    const interior = (rows: number[][]) => rows.slice(1, 21).map((row) => row.slice(1, 21));
    expect(interior(actual)).toEqual(interior(source));
    expect(
      interior(source)
        .flat()
        .every((alpha) => alpha === 0),
    ).toBe(true);
    // Row 42, just below the rounded hole, keeps shadow on both; with an
    // antialiased hole edge at 41.5, row 41 would keep some too.
    expect(source[21][10]).toBeGreaterThan(0);
    expect(actual[21][10]).toBeGreaterThan(0);
  } finally {
    await page.close();
    await output.close();
  }
});
