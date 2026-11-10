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
it.each([
  "none",
  "4px 4px 4px red",
  "4px 4px 0 red",
  "4px 0 0 red",
  "inset 0 0 2px red,4px 4px 0 blue",
  "inset 0 0 3px red,4px 4px 0 blue",
])("keeps existing selected-root flattening outside verified shadow scope: %s", async (shadow) => {
  const page = await browser.newPage({ viewport });
  try {
    await page.setContent(html(shadow));
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
