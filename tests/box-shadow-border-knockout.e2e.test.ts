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
