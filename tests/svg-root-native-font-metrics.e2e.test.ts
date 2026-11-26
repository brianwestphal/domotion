import { readFileSync } from "node:fs";
import type { Browser } from "@playwright/test";
import { __helperMetaForTest, isGlyphHelperAvailable } from "@domotion/text-engine/testing";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchChromium } from "../src/capture/index.js";
import { captureImageSvgFonts } from "../src/capture/image-svg-fonts.js";
import { isolatedPrimaryFontMetrics } from "../src/render/font-resolution.js";
import { imageFontDigest } from "../src/render/svg-image-own-fonts.js";
import { capturedElement } from "../src/test-support/captured-fixtures.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import { inlineImgSvg } from "../src/render/svg-inline.js";
import { nativeSvgProbeRow } from "./test-support/svg-image-probe.js";

// Downloaded helpers may predate the optional CoreText height fields. The
// renderer keeps its file-derived fallback for those binaries.
const macWithHelper =
  process.platform === "darwin" &&
  isGlyphHelperAvailable() &&
  __helperMetaForTest("Futura-Medium")?.ctCapHeight != null;

describe.skipIf(!macWithHelper)("isolated SVG primary CoreText metrics", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await launchChromium();
  });
  afterAll(async () => closeBrowserSafely(browser), 15_000);

  it.each(["Futura", "Palatino", "Optima", "Didot", "Baskerville", "Verdana", "Avenir Next", "Courier", "PingFang SC"])(
    "matches Chromium's ex/cap for %s",
    async (family) => {
      const page = await browser.newPage();
      try {
        const expected = await page.evaluate((name) => {
          const node = document.createElement("div");
          node.style.cssText = `position:absolute;font-family:${JSON.stringify(name)};font-size:20px;width:1ex;height:1cap`;
          document.body.append(node);
          const box = node.getBoundingClientRect();
          const result = { ex: box.width, cap: box.height };
          node.remove();
          return result;
        }, family);
        const actual = isolatedPrimaryFontMetrics({
          fontFamily: JSON.stringify(family),
          fontSize: 20,
          fontWeight: 400,
          italic: false,
        });
        expect(actual?.xHeight).not.toBeNull();
        expect(actual?.capHeight).not.toBeNull();
        expect(actual!.xHeight!).toBeCloseTo(expected.ex, 1);
        expect(actual!.capHeight!).toBeCloseTo(expected.cap, 1);
      } finally {
        await page.close();
      }
    },
    60_000,
  );

  it("inlines a Futura cap/ex root translation at the image's painted position", async () => {
    const source = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><style>svg{font-family:Futura;font-size:20px;transform:translate(1cap,1ex);transform-origin:0 0}</style><rect width="15" height="15" fill="red"/></svg>`;
    const inlined = inlineImgSvg(source, {
      x: 0,
      y: 0,
      w: 100,
      h: 100,
      par: "xMidYMid meet",
      documentViewport: true,
      idPrefix: "F-",
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
      expect(rgb(20, 15)).toEqual([255, 0, 0]);
      expect(rgb(8, 8)).toEqual([255, 255, 255]);
      expect(rgb(130, 15)).toEqual(rgb(20, 15));
      expect(rgb(118, 8)).toEqual(rgb(8, 8));
    } finally {
      await page.close();
    }
  }, 60_000);
  it.each(["ex", "cap"])(
    "matches Chromium's 30px own-font %s geometry and painted coverage (DM-HPPJ8S)",
    async (unit) => {
      const mono = readFileSync(
        new URL("../packages/text-engine/assets/fonts/fixture/DomotionFixtureMono-Regular.ttf", import.meta.url),
      );
      const svg = (offset: string) =>
        `<svg xmlns="http://www.w3.org/2000/svg" width="90" height="40" style="font:30px 'Image Face',monospace;transform:translateX(${offset})"><style>@font-face{font-family:'Image Face';src:url(data:font/ttf;base64,${mono.toString("base64")})}</style><rect width="10" height="10" fill="red"/><text x="0" y="36">Rag 0</text></svg>`;
      const source = svg(`1${unit}`);
      const imageSrc = `data:image/svg+xml,${encodeURIComponent(source)}`;
      const page = await browser.newPage();
      try {
        await page.goto(imageSrc);
        const nativeOffset = await page.evaluate(async () => {
          const root = document.documentElement;
          await document.fonts.load(getComputedStyle(root).font, "Rag 0");
          await document.fonts.ready;
          return new DOMMatrix(getComputedStyle(root).transform).e;
        });
        expect(nativeOffset).toBe(unit === "ex" ? 16.5 : 21.9);

        await page.goto("about:blank");
        const image = capturedElement({
          tag: "img",
          children: [],
          imageSrc,
          brokenImageFallback: { source: { complete: true, naturalWidth: 90 } },
          width: 90,
          height: 40,
          styles: { objectFit: "fill", objectPosition: "50% 50%" },
        });
        await captureImageSvgFonts(page, [image]);
        expect(image.imageOwnFonts?.faces[0].sha256).toBe(imageFontDigest(mono));
        const inlined = inlineImgSvg(source, {
          x: 0,
          y: 0,
          w: 90,
          h: 40,
          par: "none",
          documentViewport: true,
          idPrefix: "own-",
          ownFonts: image.imageOwnFonts,
        });
        expect(inlined).toContain(`translate(${nativeOffset} 0)`);
        const output = `<svg xmlns="http://www.w3.org/2000/svg" width="90" height="40">${inlined}</svg>`;
        const literal = svg(`${nativeOffset}px`);
        // Coverage at the leading pixel need not back-solve to the CSS offset.
        // Compare paint at each sampling scale to an explicit pixel transform.
        for (const scale of [1, 4]) {
          const expected = await nativeSvgProbeRow(page, source, scale);
          expect(expected.some((alpha) => alpha > 0)).toBe(true);
          expect(await nativeSvgProbeRow(page, literal, scale)).toEqual(expected);
          expect(await nativeSvgProbeRow(page, output, scale)).toEqual(expected);
        }
      } finally {
        await page.close();
      }
    },
  );
});
