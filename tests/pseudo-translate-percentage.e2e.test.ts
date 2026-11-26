import type { Browser, Page } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureElementTree, launchChromium } from "../src/capture/index.js";
import { CAPTURE_SCRIPT } from "../src/capture/script.generated.js";
import type { CapturedElement, CaptureScriptArgs } from "../src/capture/types.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import { forEachElement } from "../src/tree-ops/for-each-element.js";

// DM-6PRMHN: the computed `translate` longhand keeps percentages, which
// resolve against the pseudo's own border box (CSS Transforms 2 §5.1). The
// compatibility pseudo walk (`walker/pseudo-content.ts`, used when no
// source-owned pseudo fragment registry is present) composes it through the
// injected `composeEffectiveTransform`, which must receive that box; without
// it `-50%` resolves against zero. The source-owned path reads Blink's
// post-transform quads and is pinned alongside it.

const W = 120;
const H = 80;
const viewport = { x: 0, y: 0, width: W, height: H };
const html = (box: string, host = "") =>
  `<style>body{margin:0;background:white}#h{position:relative;left:40px;top:10px;width:60px;height:40px;${host}}#h::before{content:"";display:block;background:rgb(200,0,0);${box}}</style><div id=h></div>`;

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
const captureCompatibilityTree = async () => {
  const args = { selector: "body", viewport } satisfies Partial<CaptureScriptArgs>;
  const { tree } = (await page.evaluate(`(${CAPTURE_SCRIPT})(${JSON.stringify(args)})`)) as {
    tree: CapturedElement[];
  };
  return tree;
};
const pseudoBoxes = (tree: CapturedElement[]) => {
  const boxes: NonNullable<CapturedElement["pseudoBoxes"]> = [];
  forEachElement(tree, (element) => boxes.push(...(element.pseudoBoxes ?? [])));
  return boxes;
};

/** Parse a captured 2D `matrix(a, b, c, d, e, f)`. */
const parseMatrix = (value: string | undefined): number[] => {
  const match = /^matrix\(([^)]+)\)$/.exec(value ?? "");
  if (match == null) throw new Error(`expected a 2D matrix, got ${String(value)}`);
  return match[1].split(",").map((term) => Number(term));
};

const CASES = [
  ["40px border box", "width:40px;height:40px;translate:-50% 0", -20],
  [
    "content-box padding and border",
    "width:28px;height:28px;padding:4px;border:2px solid rgb(0,0,160);translate:-50% 0",
    -20,
  ],
  ["border-box sizing", "box-sizing:border-box;width:40px;height:40px;padding:6px;translate:-50% 0", -20],
  ["calc() of percentage and length", "width:40px;height:40px;translate:calc(-50% + 4px) 0", -16],
  ["vertical percentage", "width:40px;height:20px;translate:0 50%", 0],
] as const;

describe("generated pseudo translate percentages (DM-6PRMHN)", () => {
  it.each(CASES)(
    "compatibility walk resolves %s against the pseudo border box",
    async (_name, box, tx) => {
      await page.setContent(html(box));
      const expected = await rgbaPixels(await page.screenshot());
      const tree = await captureCompatibilityTree();
      const boxes = pseudoBoxes(tree);
      expect(boxes).toHaveLength(1);
      const ty = box.includes("translate:0 50%") ? 10 : 0;
      const [a, b, c, d, e, f] = parseMatrix(boxes[0].transform);
      expect([a, b, c, d]).toEqual([1, 0, 0, 1]);
      expect(e).toBeCloseTo(tx, 6);
      expect(f).toBeCloseTo(ty, 6);
      expect(diff(expected, await render(tree))).toBe(0);
      // Negative control: the reference-box-free answer (every percentage
      // against zero) leaves the box at its untransformed position.
      boxes[0].transform = `matrix(1, 0, 0, 1, ${e - tx}, ${f - ty})`;
      expect(diff(expected, await render(tree))).toBeGreaterThan(0);
    },
    60_000,
  );

  it.each(CASES)(
    "source-owned record paints %s where Chromium does",
    async (_name, box) => {
      await page.setContent(html(box));
      const expected = await rgbaPixels(await page.screenshot());
      const tree = await captureElementTree(page, "body", viewport);
      let records = 0;
      forEachElement(tree, (element) => (records += element.pseudoFragments?.length ?? 0));
      expect(records).toBe(1);
      expect(diff(expected, await render(tree))).toBe(0);
    },
    60_000,
  );
});

describe("compatibility pseudo box sizing (DM-5HZWNS)", () => {
  it.each([
    {
      name: "a static padded block",
      box: "box-sizing:border-box;width:40px;height:40px;padding:6px",
      rect: { x: 40, y: 10, width: 40, height: 40 },
    },
    {
      name: "a right and bottom anchored RTL box with padding and border",
      host: "direction:rtl",
      box: "box-sizing:border-box;position:absolute;right:4px;bottom:2px;width:40px;height:30px;padding:5px 6px;border:2px solid blue",
      rect: { x: 56, y: 18, width: 40, height: 30 },
    },
    {
      name: "a bottom-aligned padded inline-block",
      host: "font-size:0;line-height:20px",
      box: "box-sizing:border-box;display:inline-block;vertical-align:bottom;width:24px;height:14px;padding:2px;border:1px solid blue",
      rect: { x: 40, y: 16, width: 24, height: 14 },
    },
    {
      name: "padding and borders larger than the specified size",
      box: "box-sizing:border-box;width:4px;height:3px;padding:6px;border:3px solid blue",
      rect: { x: 40, y: 10, width: 18, height: 18 },
    },
  ])("captures $name at the native border box", async ({ box, host, rect }) => {
    await page.setContent(`<!doctype html>${html(box, host)}`);
    const expected = await rgbaPixels(await page.screenshot());
    const tree = await captureCompatibilityTree();
    const boxes = pseudoBoxes(tree);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toMatchObject(rect);
    expect((await render(tree)).equals(expected)).toBe(true);
  });
});
