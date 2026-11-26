import { readFileSync } from "node:fs";
import type { Browser, Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchChromium } from "../src/capture/index.js";
import { captureImageSvgFonts, fontSourceEntries, witnessRequest } from "../src/capture/image-svg-fonts.js";
import { witnessImageFonts } from "../src/capture/image-svg-font-witness.js";
import { imageFontDigest } from "../src/render/svg-image-own-fonts.js";
import { capturedElement } from "../src/test-support/captured-fixtures.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import { inlineImgSvg } from "../src/render/svg-inline.js";
import type { CapturedElement } from "../src/capture/types.js";

let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(async () => closeBrowserSafely(browser), 15_000);

const fixtureFont = (name: string): Buffer =>
  readFileSync(new URL(`../packages/text-engine/assets/fonts/fixture/${name}`, import.meta.url));
const mono = fixtureFont("DomotionFixtureMono-Regular.ttf");
const serif = fixtureFont("DomotionFixtureSerif-Regular.ttf");
const data = (bytes: Buffer): string => `url(data:font/ttf;base64,${bytes.toString("base64")})`;
const face = (src: string, descriptors = ""): string =>
  `@font-face{font-family:'Image Face';src:${src};${descriptors}}`;
/** A red probe square at the top (row 5 is text-free) and text painted in the face. */
const svg = (css: string, transform = "translateX(2ch)", text = true, size = 20): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="90" height="40" style="font:${size}px 'Image Face',monospace;transform:${transform}"><style>${css}</style><rect width="10" height="10" fill="red"/>${text ? `<text x="0" y="36">Rag 0</text>` : ""}</svg>`;
const placement = { x: 0, y: 0, w: 90, h: 40, par: "none", documentViewport: true, idPrefix: "own-" };
const fixture = (source: string): CapturedElement =>
  capturedElement({
    tag: "img",
    children: [],
    imageSrc: `data:image/svg+xml,${encodeURIComponent(source)}`,
    brokenImageFallback: { source: { complete: true, naturalWidth: 90 } },
    width: 90,
    height: 40,
    styles: { objectFit: "fill", objectPosition: "50% 50%" },
  });

async function withPage<T>(run: (page: Page) => Promise<T>): Promise<T> {
  const page = await browser.newPage();
  try {
    return await run(page);
  } finally {
    await page.close();
  }
}

/** Alpha coverage across row 5, which contains the probe and no text. */
async function nativeProbeRow(page: Page, source: string, scale = 1): Promise<number[]> {
  return page.evaluate(
    async ({ source, scale }) => {
      const image = new Image();
      image.src = `data:image/svg+xml,${encodeURIComponent(source)}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = 90 * scale;
      canvas.height = 40 * scale;
      const context = canvas.getContext("2d")!;
      context.scale(scale, scale);
      context.drawImage(image, 0, 0);
      const row = context.getImageData(0, 5 * scale, canvas.width, 1).data;
      return [...row].filter((_, index) => index % 4 === 3);
    },
    { source, scale },
  );
}

/** Estimate the probe square's left edge from its first painted column. */
async function nativeProbeX(page: Page, source: string): Promise<number> {
  const row = await nativeProbeRow(page, source);
  const x = row.findIndex((alpha) => alpha > 0);
  return x < 0 ? -1 : x + 1 - row[x] / 255;
}

describe("painted used-face witness for SVG image own fonts", () => {
  it("admits font-display:fallback when the image painted the face", async () => {
    await withPage(async (page) => {
      const source = svg(face(data(mono), "font-display:fallback"));
      const el = fixture(source);
      await captureImageSvgFonts(page, [el]);
      expect(el.imageOwnFonts?.faces).toHaveLength(1);
      expect(inlineImgSvg(source, { ...placement, ownFonts: el.imageOwnFonts })).toContain("translate(24 0)");
      expect(await nativeProbeX(page, source)).toBeCloseTo(24, 1);
      expect(await page.evaluate(() => document.fonts.size)).toBe(0);
    });
  });

  it("keeps font-display:optional raster even though its bytes are valid", async () => {
    await withPage(async (page) => {
      const source = svg(face(data(mono), "font-display:optional"));
      const el = fixture(source);
      await captureImageSvgFonts(page, [el]);
      expect(el.imageOwnFonts).toBeUndefined();
      expect(inlineImgSvg(source, { ...placement, ownFonts: el.imageOwnFonts })).toBeNull();
    });
  });

  it("admits a face that only moves face-dependent geometry, and nothing when no paint depends on it", async () => {
    await withPage(async (page) => {
      // Root 2ch moves the probe square, so the references discriminate
      // without any text.
      const used = fixture(svg(face(data(mono), "font-display:fallback"), "translateX(2ch)", false));
      const unused = fixture(svg(face(data(mono), "font-display:fallback"), "translateX(20px)", false));
      await captureImageSvgFonts(page, [used, unused]);
      expect(used.imageOwnFonts?.faces).toHaveLength(1);
      expect(unused.imageOwnFonts).toBeUndefined();
    });
  });

  it.each([
    ["an invalid earlier data source", `url(data:font/ttf;base64,AAAA) format("truetype"), ${data(mono)}`],
    ["an unsupported earlier format", `${data(serif)} format("embedded-opentype"), ${data(mono)}`],
    ["a later valid source", `${data(mono)}, ${data(serif)}`],
  ])("selects the source Chromium iterates to past %s", async (_name, src) => {
    await withPage(async (page) => {
      const source = svg(face(src));
      const el = fixture(source);
      await captureImageSvgFonts(page, [el]);
      expect(el.imageOwnFonts?.faces[0].sha256).toBe(imageFontDigest(mono));
      expect(inlineImgSvg(source, { ...placement, ownFonts: el.imageOwnFonts })).toContain("translate(24 0)");
      expect(await nativeProbeX(page, source)).toBeCloseTo(24, 1);
    });
  });

  it("negative control: a selection other than Chromium's moves the witness off 'painted'", async () => {
    await withPage(async (page) => {
      const css = face(`${data(mono)}, ${data(serif)}`);
      const source = svg(css);
      const entries = fontSourceEntries(
        `url("data:font/ttf;base64,${mono.toString("base64")}"), url("data:font/ttf;base64,${serif.toString("base64")}")`,
      )!;
      const box = { width: 90, height: 40 };
      const right = witnessRequest(source, source, [{ entries, selected: 0 }], box)!;
      const wrong = witnessRequest(source, source, [{ entries, selected: 1 }], box)!;
      expect(await witnessImageFonts(page, [right, wrong])).toEqual(["painted", "other"]);
    });
  });

  it.runIf(process.platform === "darwin").each(["ex", "cap"])(
    "matches Chromium's 30px own-font %s geometry and painted coverage (DM-HPPJ8S)",
    async (unit) => {
      const css = face(data(mono));
      const source = svg(css, `translateX(1${unit})`, true, 30);
      const nativeOffset = await withPage(async (page) => {
        await page.goto(`data:image/svg+xml,${encodeURIComponent(source)}`);
        return page.evaluate(async () => {
          const root = document.documentElement;
          await document.fonts.load(getComputedStyle(root).font, "Rag 0");
          await document.fonts.ready;
          return new DOMMatrix(getComputedStyle(root).transform).e;
        });
      });
      expect(nativeOffset).toBe(unit === "ex" ? 16.5 : 21.9);

      await withPage(async (page) => {
        const el = fixture(source);
        await captureImageSvgFonts(page, [el]);
        expect(el.imageOwnFonts?.faces[0].sha256).toBe(imageFontDigest(mono));
        const inlined = inlineImgSvg(source, { ...placement, ownFonts: el.imageOwnFonts });
        expect(inlined).toContain(`translate(${nativeOffset} 0)`);
        const output = `<svg xmlns="http://www.w3.org/2000/svg" width="90" height="40">${inlined}</svg>`;
        const literal = svg(css, `translateX(${nativeOffset}px)`, true, 30);
        // Coverage at the leading pixel need not back-solve to the CSS offset.
        // Compare paint at each sampling scale to an explicit pixel transform.
        for (const scale of [1, 4]) {
          const expected = await nativeProbeRow(page, source, scale);
          expect(expected.some((alpha) => alpha > 0)).toBe(true);
          expect(await nativeProbeRow(page, literal, scale)).toEqual(expected);
          expect(await nativeProbeRow(page, output, scale)).toEqual(expected);
        }
      });
    },
  );

  it.each(["translateX(1ex)", "translateX(1cap)", "translateX(2ch)", "translateX(1lh)"])(
    "applies size-adjust as the used size for %s, natively and in Domotion",
    async (transform) => {
      // FontDescription::SizeAdjustedFontDescription: AdjustedSize =
      // ComputedSize * size_adjust, so 150% at 20px is the face at 30px.
      await withPage(async (page) => {
        const adjusted = svg(face(data(mono), "size-adjust:150%"), transform, true, 20);
        const scaled = svg(face(data(mono)), transform, true, 30);
        const offsets: number[] = [];
        for (const source of [adjusted, scaled]) {
          const el = fixture(source);
          await captureImageSvgFonts(page, [el]);
          expect(el.imageOwnFonts?.faces).toHaveLength(1);
          const inlined = inlineImgSvg(source, { ...placement, ownFonts: el.imageOwnFonts });
          offsets.push(Number(/translate\(([\d.]+) 0\)/.exec(inlined ?? "")?.[1]));
        }
        expect(Number.isFinite(offsets[0])).toBe(true);
        expect(offsets[0]).toBe(offsets[1]);
        expect(await nativeProbeX(page, adjusted)).toBe(await nativeProbeX(page, scaled));
      });
    },
  );

  it.each([
    ["ascent-override:80%;descent-override:20%;line-gap-override:10%", "translateX(1lh)"],
    ["size-adjust:120%;ascent-override:75%;descent-override:25%;line-gap-override:0%", "translateX(1lh)"],
  ])("matches native geometry for metric descriptors %s with %s", async (descriptors, transform) => {
    await withPage(async (page) => {
      const source = svg(face(data(mono), descriptors), transform);
      const el = fixture(source);
      await captureImageSvgFonts(page, [el]);
      expect(el.imageOwnFonts?.faces).toHaveLength(1);
      const inlined = inlineImgSvg(source, { ...placement, ownFonts: el.imageOwnFonts });
      const offset = Number(/translate\(([\d.]+) 0\)/.exec(inlined ?? "")?.[1]);
      expect(Number.isFinite(offset)).toBe(true);
      expect(await nativeProbeX(page, source)).toBeCloseTo(offset, 1);
    });
  });

  it("leaves a partial line-metric override unresolved for lh but not for ch", async () => {
    await withPage(async (page) => {
      for (const [transform, inlined] of [
        ["translateX(1lh)", false],
        ["translateX(2ch)", true],
      ] as const) {
        const source = svg(face(data(mono), "ascent-override:80%"), transform);
        const el = fixture(source);
        await captureImageSvgFonts(page, [el]);
        expect(el.imageOwnFonts?.faces[0].ascentOverride).toBe(0.8);
        expect(inlineImgSvg(source, { ...placement, ownFonts: el.imageOwnFonts }) != null).toBe(inlined);
      }
    });
  });
});
