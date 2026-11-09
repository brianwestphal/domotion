import type { Browser } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isGlyphHelperAvailable } from "@domotion/text-engine/testing";
import { launchChromium } from "../src/capture/index.js";
import { isolatedPrimaryFontMetrics } from "../src/render/font-resolution.js";
import { inlineImgSvg } from "../src/render/svg-inline.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

describe.skipIf(process.platform !== "darwin" || !isGlyphHelperAvailable())("PingFang SC SVG root metrics", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await launchChromium();
  });
  afterAll(async () => closeBrowserSafely(browser), 15_000);

  it.each([12, 16, 20, 32])(
    "matches Chromium ex/ch at %ipx",
    async (size) => {
      const page = await browser.newPage();
      try {
        const expected = await page.evaluate((fontSize) => {
          const node = document.createElement("div");
          node.style.cssText = `position:absolute;font-family:"PingFang SC";font-size:${fontSize}px;width:1ex;height:1ch`;
          document.body.append(node);
          const box = node.getBoundingClientRect();
          const metrics = { ex: box.width, ch: box.height };
          node.remove();
          return metrics;
        }, size);
        const actual = isolatedPrimaryFontMetrics({
          fontFamily: '"PingFang SC"',
          fontSize: size,
          fontWeight: 400,
          italic: false,
        });
        expect(actual?.xHeight).toBeCloseTo(expected.ex, 1);
        expect(actual?.zeroWidth).toBeCloseTo(expected.ch, 1);
        expect(actual?.zeroWidth).toBeCloseTo(size * 0.6, 2);
        if (size === 20) expect(actual?.xHeight).toBeCloseTo(10.34, 2);
      } finally {
        await page.close();
      }
    },
    60_000,
  );

  it.each([12, 20, 32])(
    "places an inlined 1ch/1ex root transform like an SVG image at %ipx",
    async (size) => {
      const source = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><style>svg{font-family:"PingFang SC";font-size:${size}px;transform:translate(1ch,1ex);transform-origin:0 0}</style><rect width="15" height="15" fill="red"/></svg>`;
      const inlined = inlineImgSvg(source, {
        x: 0,
        y: 0,
        w: 100,
        h: 100,
        par: "xMidYMid meet",
        documentViewport: true,
        idPrefix: "P-",
      });
      expect(inlined).not.toBeNull();
      const page = await browser.newPage({ viewport: { width: 210, height: 100 } });
      try {
        await page.setContent(
          `<body style="margin:0;background:white"><img src="data:image/svg+xml,${encodeURIComponent(source)}" width="100" height="100" style="position:absolute;left:0;top:0">` +
            `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" style="position:absolute;left:110px;top:0">${inlined}</svg></body>`,
        );
        const screenshot = await sharp(await page.screenshot())
          .raw()
          .toBuffer({ resolveWithObject: true });
        const rgb = (x: number, y: number): number[] => {
          const offset = (y * screenshot.info.width + x) * screenshot.info.channels;
          return Array.from(screenshot.data.subarray(offset, offset + 3));
        };
        const insideX = Math.round(size * 0.6 + 5);
        const insideY = Math.round(size * 0.517 + 5);
        expect(rgb(insideX, insideY)).toEqual([255, 0, 0]);
        expect(rgb(2, 2)).toEqual([255, 255, 255]);
        expect(rgb(110 + insideX, insideY)).toEqual(rgb(insideX, insideY));
        expect(rgb(112, 2)).toEqual(rgb(2, 2));
      } finally {
        await page.close();
      }
    },
    60_000,
  );
});
