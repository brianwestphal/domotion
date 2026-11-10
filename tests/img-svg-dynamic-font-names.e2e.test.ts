import type { Browser } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchChromium } from "../src/capture/index.js";
import { inlineImgSvg } from "../src/render/svg-inline.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import { FIXTURE_FONT_CSS, FIXTURE_MONO_FAMILY, FIXTURE_SERIF_FAMILY } from "./fixture-fonts.js";

let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(async () => {
  await closeBrowserSafely(browser);
});

describe("dynamic SVG image font namespace (DM-2K0K01)", () => {
  it("isolates XML-encoded family attributes from a same-named host face (DM-10TEGA)", async () => {
    const ownCss = FIXTURE_FONT_CSS.replaceAll(FIXTURE_MONO_FAMILY, "Image & Face");
    const hostCss = FIXTURE_FONT_CSS.replaceAll(FIXTURE_SERIF_FAMILY, "Image & Face");
    const source = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40" style="font:20px &quot;Image &amp; Face&quot;"><style><![CDATA[${ownCss}]]></style><text x="5" y="26">Abc 01</text></svg>`;
    const actual = inlineImgSvg(source, {
      x: 0,
      y: 0,
      w: 120,
      h: 40,
      par: "none",
      documentViewport: true,
      idPrefix: "XML-",
    });
    expect(actual).not.toBeNull();
    expect(actual).toContain("&quot;XML-Image &amp; Face&quot;");
    const page = await browser.newPage({ viewport: { width: 240, height: 40 } });
    try {
      await page.setContent(
        `<body style="margin:0;display:flex;background:white"><style>${hostCss}img,svg{display:block}</style><img width="120" height="40" src="data:image/svg+xml,${encodeURIComponent(source)}"><svg id="actual" width="120" height="40">${actual}</svg></body>`,
      );
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(() => document.fonts.load('20px "Image & Face"'));
      const metrics = await page.locator("#actual text").evaluate((text) => {
        const range = document.createRange();
        range.selectNodeContents(text);
        const own = range.getBoundingClientRect().width;
        (text as SVGElement).style.fontFamily = '"Image & Face"';
        const host = range.getBoundingClientRect().width;
        (text as SVGElement).style.removeProperty("font-family");
        return { own, host };
      });
      expect(metrics.own).toBe(72);
      expect(metrics.host).not.toBe(metrics.own);
      const native = await sharp(await page.locator("img").screenshot())
        .raw()
        .toBuffer();
      const vector = await sharp(await page.locator("#actual").screenshot())
        .raw()
        .toBuffer();
      expect(vector).toEqual(native);
    } finally {
      await page.close();
    }
  });
  it.each([
    "font:calc(1em + 6px)/1.2 Pair",
    "font:max(12px,min(28px,2em)) Pair",
    "--font:clamp(12px,2em,24px) Pair;font:var(--font)",
  ])("keeps competing font faces isolated for %s", async (declarations) => {
    const source = (family: string): string =>
      `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="60" viewBox="0 0 100 60"><style>${FIXTURE_FONT_CSS.replaceAll(family, "Pair")} text{${declarations}}</style><text x="2" y="40">Abc 01</text></svg>`;
    const sources = [source(FIXTURE_MONO_FAMILY), source(FIXTURE_SERIF_FAMILY)];
    const inlined = sources.map((svg, index) =>
      inlineImgSvg(svg, {
        x: 0,
        y: index * 70,
        w: 100,
        h: 60,
        par: "xMidYMid meet",
        documentViewport: true,
        idPrefix: `I${index}-`,
      }),
    );
    expect(inlined.every((value) => value != null)).toBe(true);
    const page = await browser.newPage({ viewport: { width: 210, height: 140 }, deviceScaleFactor: 1 });
    try {
      await page.setContent(
        `<body style="margin:0;background:white">${sources.map((svg, index) => `<img src="data:image/svg+xml,${encodeURIComponent(svg)}" width="100" height="60" style="position:absolute;left:0;top:${index * 70}px">`).join("")}<svg xmlns="http://www.w3.org/2000/svg" width="100" height="140" style="position:absolute;left:110px;top:0">${inlined.join("")}</svg></body>`,
      );
      await page
        .locator("img")
        .evaluateAll((images) => Promise.all(images.map((image) => (image as HTMLImageElement).decode())));
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      const screenshot = await page.screenshot();
      const expected: Buffer[] = [];
      for (let index = 0; index < 2; index++) {
        expected[index] = await sharp(screenshot)
          .extract({ left: 0, top: index * 70, width: 100, height: 60 })
          .raw()
          .toBuffer();
        const actual = await sharp(screenshot)
          .extract({ left: 110, top: index * 70, width: 100, height: 60 })
          .raw()
          .toBuffer();
        expect(actual).toEqual(expected[index]);
      }
      expect(expected[0].equals(expected[1])).toBe(false);
    } finally {
      await page.close();
    }
  });
});
