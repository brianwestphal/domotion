import { chromium, type Browser } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  resolveFont,
  getFontSourceInfo,
  callGlyphHelper,
  clearGlyphHelperTransport,
} from "@domotion/text-engine/testing";
import { inlineImgSvg } from "../src/render/svg-inline.js";
import { imageRootFontMetricUnits } from "../src/render/svg-image-root-font.js";

const cases = [
  { family: "PingFang SC", size: 16, weight: 400 },
  { family: "PingFang SC", size: 19.5, weight: 400 },
  { family: "PingFang SC", size: 16.123456789, weight: 400 },
  { family: "PingFang SC", size: 24, weight: 600 },
  { family: "PingFang SC", size: 1.6, weight: 400 },
  { family: "system-ui", size: 9, weight: 400 },
  { family: "system-ui", size: 13, weight: 400 },
  { family: "system-ui", size: 72, weight: 400 },
  { family: "Arial", size: 13, weight: 400 },
  { family: "Arial", size: 19.5, weight: 400 },
  { family: "Arial", size: 24, weight: 700 },
  { family: "Times New Roman", size: 16, weight: 400 },
  { family: "Helvetica", size: 16, weight: 400 },
  { family: "Helvetica", size: 24, weight: 400 },
  { family: "Courier", size: 16, weight: 400 },
  { family: "Georgia", size: 24, weight: 400 },
  { family: "serif", size: 16, weight: 400 },
  { family: "sans-serif", size: 16, weight: 400 },
  { family: "monospace", size: 16, weight: 400 },
  { family: "system-ui", size: 16, weight: 400 },
] as const;

describe.skipIf(process.platform !== "darwin")("image SVG root normal lh on macOS", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    try {
      await browser?.close();
    } finally {
      clearGlyphHelperTransport();
    }
  });

  it("matches Chromium's computed 100lh across selected faces, weights, and sizes", async () => {
    const page = await browser.newPage();
    try {
      for (const sample of cases) {
        const chrome = await page.evaluate(({ family, size, weight }) => {
          const div = document.createElement("div");
          div.style.cssText = `font-family:${family};font-size:${size}px;font-weight:${weight};line-height:normal;width:100lh;position:absolute`;
          document.body.append(div);
          const width = parseFloat(getComputedStyle(div).width) / 100;
          div.remove();
          return width;
        }, sample);
        const declarations = {
          get: (property: string): string | null =>
            property === "font-family" ? sample.family : property === "font-weight" ? String(sample.weight) : null,
        };
        const rendered = imageRootFontMetricUnits(declarations, sample.size, null)?.("lh");
        expect(rendered, JSON.stringify(sample)).not.toBeNull();
        expect(Math.abs((rendered ?? 0) - chrome), JSON.stringify(sample)).toBeLessThan(0.01);
      }
    } finally {
      await page.close();
    }
  });
  it("reports authenticated CSS-size metadata independently of the legacy upem-sized handle", () => {
    for (const family of ["PingFang SC", "system-ui"]) {
      const positions: number[] = [];
      for (const fontSize of [13, 72]) {
        const font = resolveFont(family, 400, fontSize, 0);
        expect(font).not.toBeNull();
        const source = getFontSourceInfo(font);
        expect(source?.nameMatched).toBe(true);
        const postscriptName = source?.postscriptName ?? font!.postscriptName;
        expect(postscriptName).toBeTruthy();
        const namedPingFang = family === "PingFang SC";
        const result = callGlyphHelper({
          fonts: [
            {
              ref: "size-probe",
              fontPath: namedPingFang ? undefined : source!.path,
              postscriptName,
              variations: namedPingFang ? undefined : (source!.variationAxes ?? undefined),
              size: font!.unitsPerEm,
            },
          ],
          queries: [{ type: "meta", fontRef: "size-probe", fontSizePx: fontSize }],
        });
        const meta = result.results[0];
        expect(meta?.type).toBe("meta");
        if (meta?.type !== "meta") throw new Error("native meta response missing");
        expect(meta.coreTextMetrics).toMatchObject({
          fontRef: "size-probe",
          fontSizePx: fontSize,
          actualSizePx: fontSize,
          units: "css-px",
          unitsPerEm: font!.unitsPerEm,
          postscriptName,
          nameMatched: true,
        });
        expect(meta.coreTextMetrics!.ascent).toBeGreaterThan(0);
        expect(meta.coreTextMetrics!.ascent).toBeLessThan(fontSize * 2);
        if (family === "system-ui") positions.push(source!.variationAxes!.opsz);
      }
      // This is the live SF optical face, not an absent literal family falling
      // back to Times. Its requested optical coordinate changes with CSS size.
      if (family === "system-ui") expect(positions[0]).not.toBe(positions[1]);
    }
  });
  it.each([
    { family: "PingFang SC", size: 16 },
    { family: "PingFang SC", size: 19.5 },
    { family: "system-ui", size: 13 },
    { family: "system-ui", size: 72 },
  ])("matches native SVG image pixels for normal lh: %j", async ({ family, size }) => {
    const source = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120" viewBox="0 0 200 120"><style>svg {font-family:'${family}';font-size:${size}px;line-height:normal;transform:translateX(1lh);transform-origin:0 0}</style><rect width="20" height="60" fill="#1860b8"/></svg>`;
    const inline = inlineImgSvg(source, {
      x: 0,
      y: 0,
      w: 200,
      h: 120,
      par: "xMidYMid meet",
      documentViewport: true,
      idPrefix: "LH-",
    });
    expect(inline).not.toBeNull();
    const page = await browser.newPage({ viewport: { width: 410, height: 120 }, deviceScaleFactor: 1 });
    try {
      await page.setContent(
        `<body style="margin:0;background:white"><img src="data:image/svg+xml,${encodeURIComponent(source)}" width="200" height="120" style="position:absolute;left:0;top:0"><svg xmlns="http://www.w3.org/2000/svg" width="200" height="120" style="position:absolute;left:210px;top:0">${inline}</svg></body>`,
      );
      await page.locator("img").evaluate((img) => (img as HTMLImageElement).decode());
      const screenshot = await page.screenshot();
      const expected = await sharp(screenshot).extract({ left: 0, top: 0, width: 200, height: 120 }).raw().toBuffer();
      const actual = await sharp(screenshot).extract({ left: 210, top: 0, width: 200, height: 120 }).raw().toBuffer();
      expect(actual).toEqual(expected);
    } finally {
      await page.close();
    }
  });
});
