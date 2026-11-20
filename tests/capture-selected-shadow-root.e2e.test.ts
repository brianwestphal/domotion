import type { Browser } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, expect, it } from "vitest";
import { captureElementTree, launchChromium } from "../src/capture/index.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import type { CapturedElement } from "../src/capture/types.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import { retainNativeShadowSource } from "./native-shadow-evidence.js";
const viewport = { x: 0, y: 0, width: 100, height: 100 };
let browser: Browser;
let priorGenericProbe: string | undefined;
beforeAll(async () => {
  priorGenericProbe = process.env["DOMOTION_GENERIC_PROBE"];
  process.env["DOMOTION_GENERIC_PROBE"] = "0";
  browser = await launchChromium();
});
afterAll(async () => {
  await closeBrowserSafely(browser);
  if (priorGenericProbe == null) delete process.env["DOMOTION_GENERIC_PROBE"];
  else process.env["DOMOTION_GENERIC_PROBE"] = priorGenericProbe;
});
function walk(nodes: CapturedElement[]): CapturedElement[] {
  return nodes.flatMap((node) => [node, ...walk(node.children)]);
}
async function rgba(bytes: Buffer): Promise<Buffer> {
  return sharp(bytes).ensureAlpha().raw().toBuffer();
}
function html(shadow: string, extra = ""): string {
  return `<style>body{margin:0}#only{display:block;width:20px;height:20px;margin:0;padding:0;border:0;background:transparent;box-shadow:${shadow};${extra}}</style><div id="container"><div id="only"></div></div>`;
}
it("preserves painted children of a boxless selected shadow host", async () => {
  const page = await browser.newPage({ viewport });
  const output = await browser.newPage({ viewport });
  try {
    const fixtureHtml =
      '<style>body{margin:0}#only{display:contents;box-shadow:inset 0 0 0 20px red}.child{display:block;width:12px;height:12px;background:blue}</style><div id="only"><div class="child"></div></div>';
    await page.setContent(fixtureHtml);
    const sourcePng = await page.screenshot({ omitBackground: true });
    const witness = retainNativeShadowSource({
      id: "selected-boxless-child",
      label: "boxless selected shadow host",
      fixtureFile: import.meta.url,
      fixtureHtml,
      browserVersion: browser.version(),
      viewport,
      sourcePng,
    });
    const source = await rgba(sourcePng);
    expect([...source.subarray((5 * 100 + 5) * 4, (5 * 100 + 5) * 4 + 4)]).toEqual([0, 0, 255, 255]);
    const tree = await captureElementTree(page, "#only", viewport);
    await output.setContent("<style>body{margin:0}</style>" + elementTreeToSvg(tree, 100, 100));
    const outputPng = await output.screenshot({ omitBackground: true });
    witness.output("#only", outputPng);
    expect(await rgba(outputPng)).toEqual(source);
  } finally {
    await page.close();
    await output.close();
  }
});
const insetShadows = ["inset 0 0 0 20px red", "inset 0 0 0 3px red", "inset 0 0 0 3px blue,inset 0 0 0 20px red"];
it.each(insetShadows)("retains the selected root for source inset paint %s", async (shadow) => {
  const page = await browser.newPage({ viewport });
  const output = await browser.newPage({ viewport });
  try {
    const fixtureHtml = html(shadow);
    await page.setContent(fixtureHtml);
    const sourcePng = await page.screenshot({ omitBackground: true });
    const witness = retainNativeShadowSource({
      id: `selected-inset-${insetShadows.indexOf(shadow)}`,
      label: shadow,
      fixtureFile: import.meta.url,
      fixtureHtml,
      browserVersion: browser.version(),
      viewport,
      sourcePng,
    });
    const source = await rgba(sourcePng);
    const computed = await page.locator("#only").evaluate((node) => getComputedStyle(node).boxShadow);
    for (const selector of ["#only", "#container", "body"]) {
      const tree = await captureElementTree(page, selector, viewport);
      const owners = walk(tree).filter((node) => node.styles.boxShadow === computed);
      expect(owners, selector).toHaveLength(1);
      expect(owners[0].children).toEqual([]);
      if (selector !== "body") expect(tree).toEqual(owners);
      await output.setContent("<style>body{margin:0}</style>" + elementTreeToSvg(tree, 100, 100));
      const outputPng = await output.screenshot({ omitBackground: true });
      witness.output(selector, outputPng);
      expect(await rgba(outputPng), selector).toEqual(source);
    }
  } finally {
    await page.close();
    await output.close();
  }
});
// Zero-blur normal and mixed lists are admitted: the producer is byte-exact
// for sharp, circular, elliptical and unequal round contours at an integral
// paint space (DM-9B7A6G). Each case pins direct, parent and body capture
// against the native full-RGBA screenshot.
const hardShadows: Array<[string, string, string]> = [
  ["hard-sharp", "4px 4px 0 red", ""],
  ["hard-horizontal", "4px 0 0 red", ""],
  ["hard-spread", "-3px 2px 0 2px red", ""],
  ["hard-coincident-spread", "0 0 0 3px red", ""],
  ["hard-two-normal", "4px 4px 0 red,-4px -4px 0 blue", ""],
  ["hard-mixed", "inset 0 0 0 3px blue,4px 4px 0 rgba(255,0,0,.5)", ""],
  ["hard-circular", "4px 4px 0 red", "border-radius:5px"],
  ["hard-circular-spread", "-3px 2px 0 2px red", "border-radius:5px"],
  ["hard-elliptical", "4px 4px 0 red", "border-radius:8px/4px"],
  ["hard-unequal", "4px 4px 0 red", "border-radius:8px 0 3px 5px"],
  ["hard-mixed-unequal", "inset 0 0 0 3px blue,4px 4px 0 rgba(255,0,0,.5)", "border-radius:8px 0 3px 5px"],
  ["hard-pill", "4px 4px 0 red", "border-radius:50%"],
  ["inset-elliptical", "inset 0 0 0 3px red", "border-radius:8px/4px"],
  ["inset-unequal", "inset 0 0 0 3px red", "border-radius:8px 0 3px 5px"],
  ["inset-offset-unequal", "inset 2px 2px 0 red", "border-radius:8px 0 3px 5px"],
  ["hard-sharp-corner-shape", "4px 4px 0 red", "corner-shape:bevel"],
  ["hard-superellipse-round", "4px 4px 0 red", "border-radius:5px;corner-shape:superellipse(1)"],
];
it.each(hardShadows)("retains the selected root for source hard shadow paint %s", async (id, shadow, extra) => {
  const page = await browser.newPage({ viewport });
  const output = await browser.newPage({ viewport });
  try {
    const fixtureHtml = html(shadow, `margin:20px;${extra}`);
    await page.setContent(fixtureHtml);
    const sourcePng = await page.screenshot({ omitBackground: true });
    const witness = retainNativeShadowSource({
      id: `selected-${id}`,
      label: `${shadow} ${extra}`.trim(),
      fixtureFile: import.meta.url,
      fixtureHtml,
      browserVersion: browser.version(),
      viewport,
      sourcePng,
    });
    const source = await rgba(sourcePng);
    const computed = await page.locator("#only").evaluate((node) => getComputedStyle(node).boxShadow);
    for (const selector of ["#only", "#container", "body"]) {
      const tree = await captureElementTree(page, selector, viewport);
      const owners = walk(tree).filter((node) => node.styles.boxShadow === computed);
      expect(owners, selector).toHaveLength(1);
      if (selector === "#only") expect(tree).toEqual(owners);
      await output.setContent("<style>body{margin:0}</style>" + elementTreeToSvg(tree, 100, 100));
      const outputPng = await output.screenshot({ omitBackground: true });
      witness.output(selector, outputPng);
      expect(await rgba(outputPng), selector).toEqual(source);
    }
    // Negative control: the same direct root without its shadow layers must
    // not reproduce the native paint, so the equality above measures them.
    const direct = await captureElementTree(page, "#only", viewport);
    direct[0].styles.boxShadow = "none";
    await output.setContent("<style>body{margin:0}</style>" + elementTreeToSvg(direct, 100, 100));
    expect(await rgba(await output.screenshot({ omitBackground: true }))).not.toEqual(source);
  } finally {
    await page.close();
    await output.close();
  }
});
// A lone blurred normal layer on a sharp whole-pixel box is admitted where
// every stage of Skia's mask-filter blur is equal to the producer's
// (DM-RRWR8E, `shadow-blur-authority.ts`): σ ≥ 2 with an agreeing box window,
// a shadow rect too small for the analytic BlurRect profile, and color
// channels of 0 or 255 at any alpha. Each case pins direct, parent and body
// capture against the native full-RGBA screenshot.
const blurredShadows: Array<[string, string, string]> = [
  ["blur-small-box", "4px 4px 4px red", "width:10px;height:10px"],
  ["blur-box-route", "4px 4px 8px red", ""],
  ["blur-odd-agreeing-window", "-3px 2px 5px -2px blue", "width:14px;height:14px"],
  ["blur-alpha-black", "-3px 2px 6px 1px rgba(0,0,0,.4)", "width:10px;height:10px"],
  ["blur-white-negative-spread", "0 0 12px -1px white", ""],
  ["blur-window-14", "2px 3px 15px rgba(255,0,255,.7)", ""],
  ["blur-with-inset", "inset 0 0 0 3px blue,4px 4px 9px red", ""],
];
it.each(blurredShadows)("retains the selected root for source blurred shadow paint %s", async (id, shadow, extra) => {
  const page = await browser.newPage({ viewport });
  const output = await browser.newPage({ viewport });
  try {
    const fixtureHtml = html(shadow, `margin:20px;${extra}`);
    await page.setContent(fixtureHtml);
    const sourcePng = await page.screenshot({ omitBackground: true });
    const witness = retainNativeShadowSource({
      id: `selected-${id}`,
      label: `${shadow} ${extra}`.trim(),
      fixtureFile: import.meta.url,
      fixtureHtml,
      browserVersion: browser.version(),
      viewport,
      sourcePng,
    });
    const source = await rgba(sourcePng);
    const computed = await page.locator("#only").evaluate((node) => getComputedStyle(node).boxShadow);
    for (const selector of ["#only", "#container", "body"]) {
      const tree = await captureElementTree(page, selector, viewport);
      const owners = walk(tree).filter((node) => node.styles.boxShadow === computed);
      expect(owners, selector).toHaveLength(1);
      if (selector === "#only") expect(tree).toEqual(owners);
      await output.setContent("<style>body{margin:0}</style>" + elementTreeToSvg(tree, 100, 100));
      const outputPng = await output.screenshot({ omitBackground: true });
      witness.output(selector, outputPng);
      expect(await rgba(outputPng), selector).toEqual(source);
    }
    // Negative controls: the direct root must not reproduce the native paint
    // without its shadow, nor with the blurred layer's radius 2px larger.
    for (const boxShadow of [
      "none",
      computed.replace(/(-?[\d.]+)px (-?[\d.]+)px ([1-9][\d.]*)px/, (_m, x: string, y: string, b: string) => {
        return `${x}px ${y}px ${Number(b) + 2}px`;
      }),
    ]) {
      expect(boxShadow).not.toBe(computed);
      const direct = await captureElementTree(page, "#only", viewport);
      direct[0].styles.boxShadow = boxShadow;
      await output.setContent("<style>body{margin:0}</style>" + elementTreeToSvg(direct, 100, 100));
      expect(await rgba(await output.screenshot({ omitBackground: true })), boxShadow).not.toEqual(source);
    }
  } finally {
    await page.close();
    await output.close();
  }
});
it.each([
  ["none", ""],
  // Analytic BlurRect profile (sharp rect large enough for filterRectsToNine).
  ["4px 4px 4px red", ""],
  ["4px 4px 6px 1px red", ""],
  // Rounded coverage, σ < 2, disagreeing pass rounding (window 7), a color
  // channel other than 0/255, and two normal layers.
  ["4px 4px 4px red", "border-radius:5px"],
  ["4px 4px 3px red", "width:10px;height:10px"],
  ["4px 4px 7px red", "width:10px;height:10px"],
  ["4px 4px 8px #336699", "width:10px;height:10px"],
  ["4px 4px 8px red,-4px -4px 8px blue", "width:10px;height:10px"],
  ["inset 0 0 2px red,4px 4px 0 blue", ""],
  ["inset 0 0 3px red,4px 4px 0 blue", ""],
  ["4px 4px 0 red", "border-radius:5px;corner-shape:bevel"],
  ["4px 4px 0 red", "border-radius:5px;corner-shape:squircle"],
  ["4px 4px 0 red", "border-shape:circle(50%)"],
  ["inset 0 0 0 3px red", "border-radius:5px;corner-shape:bevel"],
  ["inset 0 0 0 3px red", "border-radius:5px;corner-shape:squircle"],
  ["inset 0 0 0 3px red", "border-radius:5px;corner-shape:notch"],
  ["inset 0 0 0 3px red", "border-radius:5px;corner-shape:superellipse(3)"],
  ["inset 0 0 0 3px red", "border-shape:circle(50%)"],
  ["4px 4px 0 red", "margin:.5px"],
  ["4px 4px 0 red", "transform:translateX(1px)"],
])("keeps existing selected-root flattening outside verified shadow scope: %s %s", async (shadow, extra) => {
  const page = await browser.newPage({ viewport });
  try {
    await page.setContent(html(shadow, extra));
    expect(await captureElementTree(page, "#only", viewport)).toEqual([]);
    const parent = await captureElementTree(page, "#container", viewport);
    expect(parent).toHaveLength(1);
    expect(parent[0].children).toEqual([]);
  } finally {
    await page.close();
  }
});
it.each(["display:none", "visibility:hidden", "width:0;height:0"])(
  "preserves existing visibility and geometry pruning: %s",
  async (extra) => {
    const page = await browser.newPage({ viewport });
    try {
      await page.setContent(html("inset 0 0 0 20px red", extra));
      expect(await captureElementTree(page, "#only", viewport)).toEqual([]);
    } finally {
      await page.close();
    }
  },
);
