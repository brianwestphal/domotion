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
];
it.each(cases)(
  "matches complete native pixels for $name",
  async (sample) => {
    const page = await browser.newPage({ viewport }),
      output = await browser.newPage({ viewport });
    try {
      const fixtureHtml = `<style>body{margin:0}#only{display:block;width:20px;height:20px;margin:20px;border:0;background:transparent;box-shadow:${sample.shadow};${sample.extra ?? ""}}</style><div id="container"><div id="only"></div></div>`;
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
      // New shadow-only outset/mixed selected roots remain refused while
      // paint-space/contour authority is unresolved. Keep complete native pixel
      // assertions on the existing container/body producer, plus owned BG roots.
      if (!("ownsOtherRootPaint" in sample && sample.ownsOtherRootPaint)) {
        expect(await captureElementTree(page, "#only", viewport)).toEqual([]);
      }
      for (const selector of "ownsOtherRootPaint" in sample && sample.ownsOtherRootPaint
        ? ["#only", "#container", "body"]
        : ["#container", "body"]) {
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

it.each([
  "border-radius:8px / 4px",
  "border-radius:8px 0 3px 5px",
  "border-radius:50%",
  "border-radius:5px;corner-shape:bevel",
])("retains the selected-root boundary for an unauthenticated contour: %s", async (extra) => {
  const page = await browser.newPage({ viewport });
  try {
    await page.setContent(
      `<style>body{margin:0}#only{width:20px;height:20px;margin:20px;box-shadow:4px 4px 0 red;${extra}}</style><div id="only"></div>`,
    );
    expect(await captureElementTree(page, "#only", viewport)).toEqual([]);
  } finally {
    await page.close();
  }
});

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

// ApplySpreadToShadowShape (box_painter_base.cc:91-97, Chromium 7d859f27) grows
// a radius smaller than the spread by the coverage-factor corner correction,
// not linearly. The shapes are geometrically Blink's, but these corners keep the
// unattributed arc coverage residual tracked for elliptical/unequal contours,
// so the bound is a small alpha residual, not byte equality. The linear rule
// measured max alpha deltas of 90, 255, 251 and 124 on these cases.
it.each([
  { name: "small radius, larger spread", css: "box-shadow:0 0 0 4px red;border-radius:2px", maxAlpha: 10 },
  { name: "offset with a large spread", css: "box-shadow:3px 2px 0 8px red;border-radius:1px", maxAlpha: 1 },
  { name: "three times the radius", css: "box-shadow:0 0 0 10px red;border-radius:3px", maxAlpha: 1 },
  { name: "unequal corners", css: "box-shadow:0 0 0 5px red;border-radius:2px 0 4px 8px", maxAlpha: 3 },
])("corrects small shadow radii by the spread coverage factor: $name", async ({ css, maxAlpha }) => {
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
    const actual = await rgba(await output.screenshot({ omitBackground: true }));
    let worst = 0;
    for (let i = 3; i < source.length; i += 4) worst = Math.max(worst, Math.abs(source[i] - actual[i]));
    expect(worst).toBeLessThanOrEqual(maxAlpha);
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
  { name: "scale transform", extra: "margin:20.5px;transform:scale(2)", wrap: "", snap: null },
  { name: "rotated live ancestor", extra: "margin:20.5px", wrap: "transform:rotate(10deg)", snap: null },
  { name: "paint containment", extra: "margin:20.5px;contain:paint", wrap: "", snap: null },
  { name: "isolating ancestor", extra: "margin:20.5px", wrap: "contain:paint", snap: null },
  { name: "sticky position", extra: "margin:20.5px;position:sticky;top:0", wrap: "", snap: null },
  { name: "will-change transform", extra: "margin:20.5px;will-change:transform", wrap: "", snap: null },
  { name: "percentage translate", extra: "margin:20.5px;translate:2.5%", wrap: "", snap: null },
])("records the source-owned border paint snap: $name", async ({ extra, wrap, snap }) => {
  const page = await browser.newPage({ viewport });
  try {
    await page.setContent(
      `<style>body{margin:0}#only{width:20px;height:20px;margin:20px;box-shadow:4px 0 0 red;${extra}}</style><div id="container" style="${wrap}"><div id="only"></div></div>`,
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
