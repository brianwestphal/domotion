import { readFileSync } from "node:fs";
import type { Browser } from "@playwright/test";
import { buildVariableHintedFont } from "@domotion/text-engine/testing";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { captureElementTree, discoverAndRegisterWebfonts, launchChromium } from "../src/capture/index.js";
import { captureImageSvgFonts } from "../src/capture/image-svg-fonts.js";
import { parseCssFontFamilyEntries, serializeCapturedFontFamilyStack } from "../src/font-family-stack.js";
import {
  clearWebfonts,
  getFontInstance,
  isolatedPrimaryFontMetrics,
  registerWebfont,
  resolveFontKey,
} from "../src/render/font-resolution.js";
import { flattenImgSvg, inlineImgSvg } from "../src/render/svg-inline.js";
import { capturedElement } from "../src/test-support/captured-fixtures.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

const mono = readFileSync(
  new URL("../packages/text-engine/assets/fonts/fixture/DomotionFixtureMono-Regular.ttf", import.meta.url),
);
const wider = buildVariableHintedFont({ family: "N80 Wide", firstCodePoint: 0x30, withOs2: true, aXMax: 650 });
const css = (name: string): string =>
  serializeCapturedFontFamilyStack({
    source: "blink-font-family-stack-v1",
    entries: [{ name, type: "family-name" }],
    genericFamily: "none",
  });
const face = (name: string, bytes: Buffer): string =>
  `@font-face{font-family:${css(name)};src:url(data:font/ttf;base64,${bytes.toString("base64")});font-display:block}`;
const cases = [
  { name: " Face " },
  { name: " Face" },
  { name: "Face " },
  { name: "  Face  " },
  { name: "\tFace\t" },
  { name: "\u00a0Face\u00a0" },
  { name: " " },
  { name: "" },
  { name: '"Quote"' },
  { name: "serif" },
  { name: " serif " },
  { name: " Face ", familyCss: "\\ Face\\ " },
];
let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium();
});
afterEach(() => clearWebfonts());
afterAll(async () => closeBrowserSafely(browser), 15_000);

describe("DM-N80HJW literal family identity", () => {
  it.each(cases)("matches native exact-name face and capture/registration: $name $familyCss", async (entry) => {
    const familyCss = entry.familyCss ?? css(entry.name);
    const trimmed = entry.name.trim().replace(/^["']|["']$/g, "");
    const style = (trimmed !== entry.name ? face(trimmed, wider) : "") + face(entry.name, mono);
    const page = await browser.newPage();
    try {
      await page.setContent(
        `<style>${style}</style><span id="probe" style="font-size:20px;line-height:1;white-space:pre">0</span>`,
      );
      await page.locator("#probe").evaluate((element, family) => {
        (element as HTMLElement).style.fontFamily = family;
      }, familyCss);
      await page.evaluate((family) => document.fonts.load("20px " + family, "0"), familyCss);
      const native = await page.locator("#probe").evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return { width: range.getBoundingClientRect().width, family: getComputedStyle(element).fontFamily };
      });
      registerWebfont({ decodedName: entry.name }, 400, "normal", mono);
      const candidate = getFontInstance("webfont:" + entry.name.toLowerCase(), 400, 20, 0)!;
      const advance = ((candidate.glyphForCodePoint(0x30)!.advanceWidth ?? NaN) / candidate.unitsPerEm) * 20;
      registerWebfont({ decodedName: trimmed }, 400, "normal", wider);
      const other = getFontInstance("webfont:" + trimmed.toLowerCase(), 400, 20, 0)!;
      const otherAdvance = ((other.glyphForCodePoint(0x30)!.advanceWidth ?? NaN) / other.unitsPerEm) * 20;
      expect(advance).toBe(12);
      expect(otherAdvance).toBe(14);
      expect(native.width).toBe(advance);
      const faces =
        trimmed === entry.name
          ? [{ family: entry.name, data: mono }]
          : [
              { family: trimmed, data: wider },
              { family: entry.name, data: mono },
            ];
      expect(
        isolatedPrimaryFontMetrics({
          fontFamily: familyCss,
          fontSize: 20,
          fontWeight: 400,
          italic: false,
          fontFaces: faces,
        })?.zeroWidth,
      ).toBe(native.width);
      expect(parseCssFontFamilyEntries(native.family)).toEqual([
        { name: entry.name, type: "family-name", quoted: native.family.startsWith('"') },
      ]);
      clearWebfonts();
      const reports = await discoverAndRegisterWebfonts(page);
      expect(reports.some((report) => report.ok && report.family === entry.name)).toBe(true);
      expect(resolveFontKey(native.family)).toBe("webfont:" + entry.name.toLowerCase());
      expect(getFontInstance(resolveFontKey(native.family), 400, 20, 0)!.glyphForCodePoint(0x30).advanceWidth).toBe(
        600,
      );
      const tree = await captureElementTree(page, "#probe", { x: 0, y: 0, width: 100, height: 40 });
      expect(tree[0].styles.fontFamilyStack?.entries[0]).toEqual({ name: entry.name, type: "family-name" });
    } finally {
      await page.close();
    }
  });
});

describe.each([false, true])("DM-N80HJW image-own family metrics (flatten=%s)", (flatten) => {
  it.each(cases)("matches native ch geometry without caller-family collision: $name $familyCss", async (entry) => {
    const familyCss = entry.familyCss ?? css(entry.name);
    const source = `<svg xmlns="http://www.w3.org/2000/svg" width="60" height="40"><style><![CDATA[${face(entry.name, mono)}svg{font:20px ${familyCss};transform:translate(2ch,0);transform-origin:0 0}]]></style><rect width="8" height="20" fill="red"/><text y="34" fill="blue">0</text></svg>`;
    const page = await browser.newPage({ viewport: { width: 60, height: 40 }, deviceScaleFactor: 1 });
    try {
      await page.setContent(
        `<body style="margin:0;background:white"><img width="60" height="40" style="display:block" src="data:image/svg+xml,${encodeURIComponent(source)}">`,
      );
      await page.locator("img").evaluate((image) => (image as HTMLImageElement).decode());
      const native = await page.locator("img").screenshot();
      const pixels = await sharp(native).raw().toBuffer();
      const channels = pixels.length / (60 * 40);
      expect([...pixels.subarray((5 * 60 + 24) * channels, (5 * 60 + 24) * channels + 3)]).toEqual([255, 0, 0]);
      expect([...pixels.subarray((5 * 60 + 23) * channels, (5 * 60 + 23) * channels + 3)]).toEqual([255, 255, 255]);
      const element = capturedElement({
        tag: "img",
        children: [],
        imageSrc: `data:image/svg+xml,${encodeURIComponent(source)}`,
        brokenImageFallback: { source: { complete: true, naturalWidth: 60 } },
      });
      await captureImageSvgFonts(page, [element]);
      expect(element.imageOwnFonts?.faces[0].family).toBe(entry.name);
      registerWebfont({ decodedName: entry.name }, 400, "normal", wider);
      const placement = {
        x: 0,
        y: 0,
        w: 60,
        h: 40,
        par: "none",
        documentViewport: true,
        idPrefix: "N80-",
        ownFonts: element.imageOwnFonts,
      };
      const output = (flatten ? flattenImgSvg(source, placement) : null) ?? inlineImgSvg(source, placement);
      expect(output).not.toBeNull();
      expect(output).toContain("translate(24 0)");
      expect(getFontInstance(resolveFontKey(css(entry.name)), 400, 20, 0)!.glyphForCodePoint(0x30).advanceWidth).toBe(
        700,
      );
      await page.setContent(`<body style="margin:0;background:white"><svg width="60" height="40">${output}</svg>`);
      const actual = await page.locator("body > svg").screenshot();
      expect((await sharp(actual).raw().toBuffer()).equals(pixels)).toBe(true);
    } finally {
      await page.close();
    }
  });
});
