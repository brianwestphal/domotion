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
function html(style: string, host = "", child = ""): string {
  return `<style>body{margin:0}#container{${host}}#only{width:20px;height:20px;box-shadow:inset 0 0 0 3px red;${style}}</style><div id="container"><div id="only">${child}</div></div>`;
}

it.each([0, 5])("retains exact ordinary integral inset roots with radius%s", async (radius) => {
  const page = await browser.newPage({ viewport });
  const output = await browser.newPage({ viewport });
  try {
    const fixtureHtml = html(`margin:20px;border-radius:${radius}px`);
    await page.setContent(fixtureHtml);
    const sourcePng = await page.screenshot({ omitBackground: true });
    const witness = retainNativeShadowSource({
      id: `integral-inset-radius-${radius}`,
      label: `ordinary integral inset radius ${radius}`,
      fixtureFile: import.meta.url,
      fixtureHtml,
      browserVersion: browser.version(),
      viewport,
      sourcePng,
    });
    const source = await rgba(sourcePng);
    for (const selector of ["#only", "#container", "body"]) {
      const tree = await captureElementTree(page, selector, viewport);
      expect(tree).toHaveLength(1);
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

const unsupported = [
  { name: "fractional sharp origin", style: "margin:20.5px" },
  { name: "fractional rounded origin", style: "margin:20.5px;border-radius:5px" },
  { name: "fractional border size", style: "margin:20px;width:20.5px;height:20.5px" },
  {
    name: "fractional local rect at integral viewport bounds",
    style: "position:absolute;left:20.5px;top:20.5px;transform:translate(.5px,.5px)",
    integralViewport: true,
  },
  {
    name: "ancestor transform at integral viewport bounds",
    host: "position:relative;width:100px;height:100px;transform:translate(.5px,.5px)",
    style: "position:absolute;left:20.5px;top:20.5px",
    integralViewport: true,
  },
  {
    name: "independent translate at integral viewport bounds",
    style: "position:absolute;left:20.5px;top:20.5px;translate:.5px .5px",
    integralViewport: true,
  },
  {
    name: "identity transform remains unauthenticated",
    host: "transform:translate(0)",
    style: "margin:20px",
    integralViewport: true,
  },
  {
    name: "zoomed local paint space",
    host: "zoom:2",
    style: "position:absolute;left:20.5px;top:20.5px",
    integralViewport: true,
  },
  { name: "prospective transform paint space", style: "margin:20px;will-change:transform" },
  { name: "filter paint space", style: "margin:20px;filter:blur(0)" },
];
it.each(unsupported)("refuses only the new shadow admission for $name", async (sample) => {
  const page = await browser.newPage({ viewport });
  try {
    await page.setContent(html(sample.style, "host" in sample ? sample.host : ""));
    const sourceRect = await page.locator("#only").evaluate((el) => el.getBoundingClientRect().toJSON());
    if ("integralViewport" in sample && sample.integralViewport) {
      expect([sourceRect.x, sourceRect.y, sourceRect.width, sourceRect.height].every(Number.isInteger)).toBe(true);
    }
    expect(await captureElementTree(page, "#only", viewport)).toEqual([]);
    // The old container route still reaches exactly the same source shadow.
    // This is structural preservation, never native-pixel parity for that gap.
    const container = await captureElementTree(page, "#container", viewport);
    expect(container).toHaveLength(1);
    expect(container[0].styles.boxShadow).toContain("inset");
    expect(container[0].tag).toBe("div");
    expect(await page.locator("#only").evaluate((el) => el.getBoundingClientRect().toJSON())).toEqual(sourceRect);
  } finally {
    await page.close();
  }
});

it.each(["background:blue", "border:1px solid blue"])(
  "preserves independently painted roots with ambiguous shadow geometry: %s",
  async (paint) => {
    const page = await browser.newPage({ viewport });
    try {
      await page.setContent(html(`margin:20.5px;${paint}`));
      const tree = await captureElementTree(page, "#only", viewport);
      expect(tree).toHaveLength(1);
      expect(tree[0].tag).toBe("div");
      expect(tree[0].styles.boxShadow).toContain("inset");
    } finally {
      await page.close();
    }
  },
);
it("preserves genuine direct text on a fractionally positioned root", async () => {
  const page = await browser.newPage({ viewport });
  try {
    await page.setContent(html("margin:20.5px;font:10px/20px Arial", "", "X"));
    const tree = await captureElementTree(page, "#only", viewport);
    expect(tree).toHaveLength(1);
    expect(tree[0].text).toBe("X");
  } finally {
    await page.close();
  }
});
it("flattens an unsupported shadow host to its independently painted child", async () => {
  const page = await browser.newPage({ viewport });
  try {
    await page.setContent(
      html("margin:20.5px", "", '<span style="display:block;width:10px;height:10px;background:green"></span>'),
    );
    const tree = await captureElementTree(page, "#only", viewport);
    expect(tree).toHaveLength(1);
    expect(tree[0].tag).toBe("span");
    expect(tree[0].styles.backgroundColor).toBe("rgb(0, 128, 0)");
    expect(tree[0].styles.boxShadow).toBe("none");
  } finally {
    await page.close();
  }
});
