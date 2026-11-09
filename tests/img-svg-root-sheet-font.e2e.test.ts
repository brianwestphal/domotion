import type { Browser } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchChromium } from "../src/capture/index.js";
import { inlineImgSvg } from "../src/render/svg-inline.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(async () => {
  await closeBrowserSafely(browser);
}, 15_000);

const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <style>svg { font-size: 30px; line-height: 40px; transform: translate(1em, 1lh); transform-origin: 0 0 }</style>
  <rect width="20" height="20" fill="red"/>
</svg>`;

describe("SVG image root font from its internal sheet", () => {
  it("positions the inlined root like Chromium's separate image document", async () => {
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
    const page = await browser.newPage({ viewport: { width: 210, height: 100 }, deviceScaleFactor: 1 });
    try {
      await page.setContent(
        `<body style="margin:0;background:white">` +
          `<img src="data:image/svg+xml,${encodeURIComponent(source)}" width="100" height="100" style="position:absolute;left:0;top:0">` +
          `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" style="position:absolute;left:110px;top:0">${inlined}</svg>` +
          `</body>`,
      );
      const screenshot = await page.screenshot();
      const pixels = await sharp(screenshot).raw().toBuffer({ resolveWithObject: true });
      const pixel = (x: number, y: number): number[] => {
        const offset = (y * pixels.info.width + x) * pixels.info.channels;
        return Array.from(pixels.data.subarray(offset, offset + 3));
      };
      expect(pixel(40, 50)).toEqual([255, 0, 0]);
      expect(pixel(150, 50)).toEqual(pixel(40, 50));
      expect(pixel(10, 10)).toEqual([255, 255, 255]);
      expect(pixel(120, 10)).toEqual(pixel(10, 10));
    } finally {
      await page.close();
    }
  }, 60_000);

  it.each([
    "small",
    "150%",
    "2em",
    "2rem",
    "calc(2em + 1px)",
    "larger",
    "min(2em, 20px)",
    "max(1em, 20px)",
    "clamp(20px, 1em, 10px)",
    "calc(1em + calc(1em + 1px))",
  ])(
    "matches Chromium image pixels for root font-size %s",
    async (size) => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><style>svg { font-size: ${size}; transform: translateX(1em); transform-origin: 0 0 }</style><rect width="20" height="20" fill="red"/></svg>`;
      const inlined = inlineImgSvg(svg, {
        x: 0,
        y: 0,
        w: 100,
        h: 100,
        par: "xMidYMid meet",
        documentViewport: true,
        idPrefix: "P-",
      });
      expect(inlined).not.toBeNull();
      const page = await browser.newPage({ viewport: { width: 210, height: 100 }, deviceScaleFactor: 1 });
      try {
        await page.setContent(
          `<body style="margin:0;background:white">` +
            `<img src="data:image/svg+xml,${encodeURIComponent(svg)}" width="100" height="100" style="position:absolute;left:0;top:0">` +
            `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" style="position:absolute;left:110px;top:0">${inlined}</svg>` +
            `</body>`,
        );
        const screenshot = await page.screenshot();
        const expected = await sharp(screenshot).extract({ left: 0, top: 0, width: 100, height: 100 }).raw().toBuffer();
        const actual = await sharp(screenshot).extract({ left: 110, top: 0, width: 100, height: 100 }).raw().toBuffer();
        expect(actual).toEqual(expected);
      } finally {
        await page.close();
      }
    },
    60_000,
  );

  it.each([
    "--Size:24px; --size:10px; font-size:var(--Size)",
    "--size:clamp(12px, 2em, 24px); font-size:var(--size)",
    "--size:var(--size); font-size:var(--size,20px)",
    "--font:small-caps 550 min(24px, 2em) serif; font:var(--font)",
  ])("matches Chromium image geometry for root custom properties: %s", async (declarations) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><style>svg {${declarations}; transform:translateX(1em);transform-origin:0 0}</style><rect width="20" height="20" fill="red"/></svg>`;
    const inlined = inlineImgSvg(svg, {
      x: 0,
      y: 0,
      w: 100,
      h: 100,
      par: "xMidYMid meet",
      documentViewport: true,
      idPrefix: "V-",
    });
    expect(inlined).not.toBeNull();
    const page = await browser.newPage({ viewport: { width: 210, height: 100 }, deviceScaleFactor: 1 });
    try {
      await page.setContent(
        `<body style="margin:0;background:white"><img src="data:image/svg+xml,${encodeURIComponent(svg)}" width="100" height="100" style="position:absolute;left:0;top:0"><svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" style="position:absolute;left:110px;top:0">${inlined}</svg></body>`,
      );
      await page.locator("img").evaluate((image: HTMLImageElement) => image.decode());
      const screenshot = await page.screenshot();
      const expected = await sharp(screenshot).extract({ left: 0, top: 0, width: 100, height: 100 }).raw().toBuffer();
      const actual = await sharp(screenshot).extract({ left: 110, top: 0, width: 100, height: 100 }).raw().toBuffer();
      expect(actual).toEqual(expected);
    } finally {
      await page.close();
    }
  });

  it.each([
    "font-size: 30px; font: italic bold 20px/1.5 Georgia",
    "font: italic bold 20px/1.5 Georgia; font-size: 30px",
    "font: small-caps 550 clamp(12px, 2em, 24px)/1.5 Georgia",
    "font: oblique 12deg max(1em, 20px)/1.5 Georgia",
    "font-variant-caps: small-caps; font: initial",
  ])("matches Chromium image pixels for sheet font shorthand order: %s", async (declarations) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><style>svg { ${declarations}; transform: translate(1em, 1lh); transform-origin: 0 0 }</style><rect width="20" height="20" fill="red"/></svg>`;
    const inlined = inlineImgSvg(svg, {
      x: 0,
      y: 0,
      w: 100,
      h: 100,
      par: "xMidYMid meet",
      documentViewport: true,
      idPrefix: "P-",
    });
    expect(inlined).not.toBeNull();
    const page = await browser.newPage({ viewport: { width: 210, height: 100 }, deviceScaleFactor: 1 });
    try {
      await page.setContent(
        `<body style="margin:0;background:white">` +
          `<img src="data:image/svg+xml,${encodeURIComponent(svg)}" width="100" height="100" style="position:absolute;left:0;top:0">` +
          `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" style="position:absolute;left:110px;top:0">${inlined}</svg>` +
          `</body>`,
      );
      const screenshot = await page.screenshot();
      const expected = await sharp(screenshot).extract({ left: 0, top: 0, width: 100, height: 100 }).raw().toBuffer();
      const actual = await sharp(screenshot).extract({ left: 110, top: 0, width: 100, height: 100 }).raw().toBuffer();
      expect(actual).toEqual(expected);
    } finally {
      await page.close();
    }
  });
});
