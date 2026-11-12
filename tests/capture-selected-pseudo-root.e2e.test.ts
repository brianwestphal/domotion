import type { Browser } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, expect, it } from "vitest";
import { captureElementTree, launchChromium } from "../src/capture/index.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// DM-HZPAYY: a selected ordinary root whose only paint is a generated pseudo
// is admitted from its source-owned native pseudo record, not from computed
// content, so unpainted pseudos still admit nothing.
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

const cases = [
  {
    name: "::before block box",
    css: '#only::before{content:"";display:block;width:20px;height:20px;background:red}',
    roots: 1,
  },
  {
    name: "::after block box",
    css: '#only::after{content:"";display:block;width:20px;height:20px;background:red}',
    roots: 1,
  },
  { name: "::before text", css: '#only::before{content:"X";color:red;font:20px/20px Arial}', roots: 1 },
  {
    name: "hidden ::before",
    css: '#only::before{content:"";display:block;width:20px;height:20px;background:red;visibility:hidden}',
    roots: 0,
  },
  { name: "content:none", css: "#only::before{content:none}", roots: 0 },
];

it.each(cases)("captures a selected root whose only paint is a generated pseudo: $name", async ({ css, roots }) => {
  const page = await browser.newPage({ viewport });
  const output = await browser.newPage({ viewport });
  try {
    await page.setContent(
      `<style>body{margin:0}#container{padding:10px}#only{width:20px;height:20px}${css}</style><div id="container"><div id="only"></div></div>`,
    );
    const source = await sharp(await page.screenshot({ omitBackground: true }))
      .ensureAlpha()
      .raw()
      .toBuffer();
    const tree = await captureElementTree(page, "#only", viewport);
    expect(tree).toHaveLength(roots);
    await output.setContent("<style>body{margin:0}</style>" + elementTreeToSvg(tree, 100, 100));
    const actual = await sharp(await output.screenshot({ omitBackground: true }))
      .ensureAlpha()
      .raw()
      .toBuffer();
    expect(actual.equals(source), "selected-root output must match native RGBA").toBe(true);
  } finally {
    await page.close();
    await output.close();
  }
});
