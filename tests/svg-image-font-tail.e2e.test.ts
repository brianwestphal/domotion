import type { Browser } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureElementTree, launchChromium } from "../src/capture/index.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import { withFlattenNestedSvg, inlineImgSvg } from "../src/render/svg-inline.js";
import { parseImageFontShorthand } from "../src/render/svg-image-font-shorthand.js";
import { esc } from "../src/render/format.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import { FIXTURE_FONT_CSS, FIXTURE_MONO_FAMILY } from "./fixture-fonts.js";

let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(async () => closeBrowserSafely(browser), 15_000);

it("matches Chromium's family-tail admission without conflating strings and keywords", async () => {
  const values = [
    "123",
    "Foo 123",
    "serif Foo",
    '"A" B',
    "Foo,",
    ",Foo",
    "Foo,,Bar",
    "Foo(Bar)",
    "initial",
    "default",
    '"A\nB"',
    '"123"',
    "\\31 23",
    "Foo serif",
    "default Foo",
    "initial Foo",
    "serif,Foo",
    "SERIF",
    "--",
    "---123",
    "--Foo",
    "fangsong Foo",
    "ui-serif Foo",
    "emoji Foo",
    "ui-rounded Foo",
    "Foo/**/Bar",
    "Foo\\,Bar",
    "Foo\\ Bar",
    '"A\\\nB"',
  ].map((tail) => `16px ${tail}`);
  values.push(
    "normal normal normal normal 16px Foo",
    "normal normal normal normal normal 16px Foo",
    "16px/-1 Foo",
    "16px/1blah Foo",
    "16px/calc(1deg) Foo",
    "oblique 95deg 16px Foo",
  );
  const page = await browser.newPage();
  try {
    const native = await page.evaluate(
      (inputs) =>
        inputs.map((font) => {
          const style = document.createElement("span").style;
          style.font = font;
          return style.font !== "";
        }),
      values,
    );
    values.forEach((value, index) => expect(parseImageFontShorthand(value) != null, value).toBe(native[index]));
  } finally {
    await page.close();
  }
});

describe.each([false, true])("SVG shorthand source geometry (flatten=%s)", (flatten) => {
  it.each([
    ["calc(12px + 2px) 123", false],
    ["16px Foo 123", false],
    ["16px serif Foo", false],
    ['16px "123"', true],
    ["16px \\31 23", true],
    ["16px Foo/**/Bar", true],
  ] as const)("preserves the native image for %s", async (font, vector) => {
    const source = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50" style="${esc(`font-size:30px;font:${font};transform:translateX(1em)`)}"><rect width="10" height="10" fill="red"/></svg>`;
    const page = await browser.newPage({ viewport: { width: 100, height: 50 } });
    try {
      await page.setContent(
        `<body style="margin:0;background:white"><div id="target"><img style="display:block" width="100" height="50" src="data:image/svg+xml,${encodeURIComponent(source)}"></div>`,
      );
      const native = await sharp(await page.locator("img").screenshot())
        .raw()
        .toBuffer();
      const tree = await captureElementTree(page, "#target", { x: 0, y: 0, width: 100, height: 50 });
      const output = withFlattenNestedSvg(flatten, () => elementTreeToSvg(tree, 100, 50));
      if (vector) expect(output).not.toContain("<image ");
      await page.setContent(
        `<body style="margin:0;background:white"><img width="100" height="50" src="data:image/svg+xml,${encodeURIComponent(output)}">`,
      );
      const actual = await sharp(await page.locator("img").screenshot())
        .raw()
        .toBuffer();
      expect(actual.equals(native)).toBe(true);
    } finally {
      await page.close();
    }
  });
});

it.each([
  ["123", '"123"'],
  ["123", "\\31 23"],
  ["Foo Bar", "Foo/**/Bar"],
  ["Foo,Bar", "Foo\\,Bar"],
  ["serif", "serif"],
  ["serif", '"serif"'],
])("isolates literal %s with reference %s", async (family, tail) => {
  const css = FIXTURE_FONT_CSS.replaceAll(FIXTURE_MONO_FAMILY, family);
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="50" style="${esc(`font:20px ${tail}`)}"><style><![CDATA[${css}]]></style><text x="5" y="30">Abc 01</text></svg>`;
  const actual = inlineImgSvg(source, {
    x: 0,
    y: 0,
    w: 140,
    h: 50,
    par: "none",
    documentViewport: true,
    idPrefix: "tail-",
  });
  expect(actual).not.toBeNull();
  const page = await browser.newPage({ viewport: { width: 280, height: 50 } });
  try {
    await page.setContent(
      `<body style="margin:0;display:flex;background:white"><img width="140" height="50" src="data:image/svg+xml,${encodeURIComponent(source)}"><svg id="actual" width="140" height="50">${actual}</svg>`,
    );
    await page.locator("img").evaluate((image) => (image as HTMLImageElement).decode());
    await page.evaluate(() => document.fonts.ready);
    const native = await sharp(await page.locator("img").screenshot())
      .raw()
      .toBuffer();
    const vector = await sharp(await page.locator("#actual").screenshot())
      .raw()
      .toBuffer();
    expect(vector.equals(native)).toBe(true);
  } finally {
    await page.close();
  }
});
