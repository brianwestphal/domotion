import { readFileSync } from "node:fs";
import type { Browser } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchChromium } from "../src/capture/index.js";
import { captureImageSvgFonts } from "../src/capture/image-svg-fonts.js";
import { inlineImgSvg } from "../src/render/svg-inline.js";
import { capturedElement } from "../src/test-support/captured-fixtures.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

const font = readFileSync(
  new URL("../packages/text-engine/assets/fonts/fixture/DomotionFixtureMono-Regular.ttf", import.meta.url),
).toString("base64");
let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(async () => closeBrowserSafely(browser));

const cases = [
  {
    name: "family equality",
    family: "Face",
    attribute: 'font-family="&quot;Face&quot;"',
    css: `[font-family='"Face"'] rect{fill:red}`,
  },
  {
    name: "style equality",
    family: "Face",
    attribute: 'style="font-family:Face"',
    css: `[style='font-family:Face'] rect{fill:red}`,
  },
  {
    name: "XML data and quoted tag boundary",
    family: "Face & Co",
    attribute: 'font-family="&quot;Face &amp; Co&quot;" style="--literal:&quot;>&quot;"',
    css: `[font-family='"Face & Co"'][style='--literal:">"'] rect{fill:red}`,
  },
  {
    name: "typed attr color",
    family: "red",
    attribute: 'font-family="red"',
    css: `svg{fill:attr(font-family type(<color>),lime)}rect{fill:inherit}`,
  },
  {
    name: "absent style identity",
    family: "Face",
    attribute: 'font-family="Face"',
    css: `svg:not([style]) rect{fill:red}`,
  },
] as const;

describe("SVG authored font attributes (DM-SV4B1M)", () => {
  for (const documentViewport of [false, true]) {
    it.each(cases)(`keeps $name, documentViewport=${documentViewport}`, async ({ family, attribute, css }) => {
      const source = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40" ${attribute}><style><![CDATA[@font-face{font-family:"${family}";src:url(data:font/ttf;base64,${font})}svg{font-size:20px;fill:lime}${css}text{fill:black}]]></style><rect width="120" height="40"/><text x="4" y="28">Abc 01</text></svg>`;
      const page = await browser.newPage({ viewport: { width: 240, height: 40 }, deviceScaleFactor: 1 });
      try {
        const el = capturedElement({
          tag: "img",
          children: [],
          imageSrc: `data:image/svg+xml,${encodeURIComponent(source)}`,
          brokenImageFallback: { source: { complete: true, naturalWidth: 120 } },
        });
        await captureImageSvgFonts(page, [el]);
        expect(el.imageOwnFonts?.faces[0].data).toBe(font);
        const actual = inlineImgSvg(source, {
          x: 0,
          y: 0,
          w: 120,
          h: 40,
          par: "none",
          idPrefix: "identity-",
          documentViewport,
          ownFonts: el.imageOwnFonts,
        });
        expect(actual).not.toBeNull();
        expect(actual).toContain(`data:font/ttf;base64,${font}`);
        await page.setContent(
          `<body style="margin:0;display:flex"><img width="120" height="40" src="data:image/svg+xml,${encodeURIComponent(source)}"><svg id="actual" width="120" height="40">${actual}</svg></body>`,
        );
        await page.locator("img").evaluate((image: HTMLImageElement) => image.decode());
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        const expected = await sharp(await page.locator("img").screenshot())
          .ensureAlpha()
          .raw()
          .toBuffer();
        const output = await sharp(await page.locator("#actual").screenshot())
          .ensureAlpha()
          .raw()
          .toBuffer();
        expect([...expected.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
        expect(output).toEqual(expected);
        const width = await page.locator("#actual text").evaluate((text) => {
          const range = document.createRange();
          range.selectNodeContents(text);
          return range.getBoundingClientRect().width;
        });
        expect(width).toBe(72);
      } finally {
        await page.close();
      }
    });
  }

  it("keeps attr(style) string reads on the authored value", async () => {
    const source = `<svg xmlns="http://www.w3.org/2000/svg"><style>@font-face{font-family:Face;src:url(data:font/ttf;base64,${font})}g{content:attr(style)}</style><g style="font-family:Face"/></svg>`;
    const actual = inlineImgSvg(source, {
      x: 0,
      y: 0,
      w: 120,
      h: 40,
      par: "none",
      idPrefix: "read-",
      intrinsic: { w: 120, h: 40 },
    });
    expect(actual).not.toBeNull();
    const page = await browser.newPage();
    try {
      const values: string[] = [];
      for (const svg of [source, `<svg xmlns="http://www.w3.org/2000/svg">${actual}</svg>`]) {
        await page.goto(`data:image/svg+xml,${encodeURIComponent(svg)}`);
        values.push(await page.locator("g[style]").evaluate((element) => getComputedStyle(element).content));
      }
      expect(values).toEqual(['"font-family:Face"', '"font-family:Face"']);
    } finally {
      await page.close();
    }
  });
});
