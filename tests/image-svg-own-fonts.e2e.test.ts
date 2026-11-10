import { readFileSync } from "node:fs";
import type { Browser } from "@playwright/test";
import { buildVariableHintedFont } from "@domotion/text-engine/testing";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureElementTree, launchChromium } from "../src/capture/index.js";
import { captureImageSvgFonts } from "../src/capture/image-svg-fonts.js";
import { capturedElement } from "../src/test-support/captured-fixtures.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import { inlineImgSvg } from "../src/render/svg-inline.js";
import { forEachElement } from "../src/tree-ops/for-each-element.js";
import type { CapturedElement } from "../src/capture/types.js";

let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(async () => closeBrowserSafely(browser), 15_000);

const mono = readFileSync(
  new URL("../packages/text-engine/assets/fonts/fixture/DomotionFixtureMono-Regular.ttf", import.meta.url),
);
const serif = readFileSync(
  new URL("../packages/text-engine/assets/fonts/fixture/DomotionFixtureSerif-Regular.ttf", import.meta.url),
);
const face = (bytes: Buffer = mono, descriptors = ""): string =>
  `@font-face{font-family:'Image Face';src:url(data:font/ttf;base64,${bytes.toString("base64")});${descriptors}}`;
const svg = (css: string, imported = false, style = "font:20px 'Image Face';transform:translateX(2ch)"): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="90" height="40" style="${style}"><style>${imported ? `@import url("data:text/css,${encodeURIComponent(css)}");` : css}</style><rect width="10" height="10" fill="red"/></svg>`;
const placement = { x: 0, y: 0, w: 90, h: 40, par: "none", documentViewport: true, idPrefix: "own-" };
const fixture = (source: string, complete = true): CapturedElement =>
  capturedElement({
    tag: "img",
    children: [],
    imageSrc: `data:image/svg+xml,${encodeURIComponent(source)}`,
    brokenImageFallback: { source: { complete, naturalWidth: complete ? 90 : 0 } },
  });

describe("image-owned font metric evidence", () => {
  it("matches native quarter-unit descriptor grouping before declaration order", async () => {
    const wider = buildVariableHintedFont({
      family: "Fractional Metric",
      firstCodePoint: 0x30,
      withOs2: true,
      aXMax: 650,
    });
    const source = svg(face(mono, "font-weight:400.1") + face(wider, "font-weight:400.2"));
    const page = await browser.newPage();
    try {
      const el = fixture(source);
      await captureImageSvgFonts(page, [el]);
      const inlined = inlineImgSvg(source, { ...placement, ownFonts: el.imageOwnFonts });
      expect(inlined).toContain("translate(28 0)");
      const first = await page.evaluate(async (source) => {
        const image = new Image();
        image.src = `data:image/svg+xml,${encodeURIComponent(source)}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = 90;
        canvas.height = 40;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        const row = context.getImageData(0, 5, 90, 1).data;
        for (let x = 0; x < 90; x++) if (row[x * 4 + 3] > 0) return x;
        return -1;
      }, source);
      expect(first).toBe(28);
    } finally {
      await page.close();
    }
  });
  it("owns charset-decoded and XML-encoded font family names", async () => {
    const page = await browser.newPage();
    try {
      for (const name of ["Image café", "Image & Face"]) {
        const css = face().replaceAll("Image Face", name);
        const imported = `@import url("data:text/css;charset=windows-1252;base64,${Buffer.from(css, "latin1").toString("base64")}");`;
        const source = svg(
          imported,
          false,
          `font:20px &quot;${name.replaceAll("&", "&amp;")}&quot;;transform:translateX(2ch)`,
        );
        const el = fixture(source);
        await captureImageSvgFonts(page, [el]);
        expect(el.imageOwnFonts?.faces[0].family).toBe(name);
        const inlined = inlineImgSvg(source, { ...placement, ownFonts: el.imageOwnFonts });
        expect(inlined).toContain("translate(24 0)");
        expect(inlined).toContain(`own-${name.replaceAll("&", "&amp;")}`);
      }
    } finally {
      await page.close();
    }
  });
  it.each([
    ["1cap", "14.6"],
    ["1ex", "11"],
    ["2lh", "52"],
    ["2ic", "40"],
  ])("resolves owned Mono %s with native geometry", async (unit, length) => {
    const source = svg(face(), false, `font:20px 'Image Face';transform:translateX(${unit})`);
    const page = await browser.newPage();
    try {
      const el = fixture(source);
      await captureImageSvgFonts(page, [el]);
      const inlined = inlineImgSvg(source, { ...placement, ownFonts: el.imageOwnFonts });
      expect(inlined).not.toBeNull();
      expect(inlined).toContain(`translate(${length} 0)`);
      const first = await page.evaluate(async (source) => {
        const image = new Image();
        image.src = `data:image/svg+xml,${encodeURIComponent(source)}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = 90;
        canvas.height = 40;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        const row = context.getImageData(0, 5, 90, 1).data;
        for (let x = 0; x < 90; x++) if (row[x * 4 + 3] > 0) return x;
        return -1;
      }, source);
      expect(first).toBe(Math.floor(Number(length)));
    } finally {
      await page.close();
    }
  });
  it.each([
    [
      "descriptor-before-range",
      face(mono, "font-weight:400;unicode-range:U+0041") + face(mono, "font-weight:700;unicode-range:U+0030"),
    ],
    ["later overlapping face", face(mono) + face(serif)],
    ["zero-only range", face(mono, "unicode-range:U+0030")],
  ])("matches native image geometry for %s", async (_name, css) => {
    const source = svg(css, false, "font:400 20px 'Image Face',serif;transform:translateX(2ch)");
    const page = await browser.newPage();
    try {
      const el = fixture(source);
      await captureImageSvgFonts(page, [el]);
      const inlined = inlineImgSvg(source, { ...placement, ownFonts: el.imageOwnFonts });
      expect(inlined).not.toBeNull();
      const result = await page.evaluate(
        async ({ source, rendered }) => {
          const images = await Promise.all(
            [source, rendered].map(async (text) => {
              const image = new Image();
              image.src = `data:image/svg+xml,${encodeURIComponent(text)}`;
              await image.decode();
              return image;
            }),
          );
          const canvas = document.createElement("canvas");
          canvas.width = 90;
          canvas.height = 40;
          const context = canvas.getContext("2d")!;
          const paints = images.map((image) => {
            context.clearRect(0, 0, 90, 40);
            context.drawImage(image, 0, 0);
            return context.getImageData(0, 0, 90, 40).data;
          });
          let changed = 0;
          for (let i = 0; i < paints[0].length; i++) if (paints[0][i] !== paints[1][i]) changed++;
          return changed;
        },
        { source, rendered: `<svg xmlns="http://www.w3.org/2000/svg" width="90" height="40">${inlined}</svg>` },
      );
      expect(result).toBe(0);
    } finally {
      await page.close();
    }
  });
  it("does not borrow or replace a same-named embedding-page face", async () => {
    const page = await browser.newPage();
    try {
      await page.evaluate(async (data) => {
        const font = new FontFace("Image Face", `url(data:font/ttf;base64,${data})`);
        await font.load();
        document.fonts.add(font);
      }, serif.toString("base64"));
      const source = svg(face());
      const el = fixture(source);
      await captureImageSvgFonts(page, [el]);
      expect(inlineImgSvg(source, { ...placement, ownFonts: el.imageOwnFonts })).toContain("translate(24 0)");
      expect(await page.evaluate(() => document.fonts.size)).toBe(1);
    } finally {
      await page.close();
    }
  });
  it.each([
    { descriptor: "font-weight:100 900", offset: 28 },
    { descriptor: "", offset: 28 },
    { descriptor: "font-weight:normal", offset: 24 },
  ])("normalizes variable WOFF2 and instantiates descriptor $descriptor", async ({ descriptor, offset }) => {
    const wawoff = (await import("wawoff2" as string)) as { compress(bytes: Uint8Array): Promise<Uint8Array> };
    const bytes = Buffer.from(
      await wawoff.compress(buildVariableHintedFont({ family: "Image Variable", firstCodePoint: 0x30, withOs2: true })),
    );
    const source = svg(face(bytes, descriptor), true, "font:900 20px 'Image Face';transform:translateX(2ch)");
    const page = await browser.newPage({ viewport: { width: 190, height: 40 } });
    try {
      const el = fixture(source);
      await captureImageSvgFonts(page, [el]);
      expect(el.imageOwnFonts?.faces).toHaveLength(1);
      const inlined = inlineImgSvg(source, { ...placement, ownFonts: el.imageOwnFonts });
      expect(inlined).not.toBeNull();
      expect(inlined).toContain(`translate(${offset} 0)`);
      await page.setContent(
        `<body style="margin:0;background:white"><img src="${el.imageSrc}" width="90" height="40"><svg width="90" height="40">${inlined}</svg></body>`,
      );
      const image = await sharp(await page.screenshot())
        .raw()
        .toBuffer({ resolveWithObject: true });
      for (const x of [offset, offset + 90]) {
        const at = (5 * image.info.width + x) * image.info.channels;
        expect(Array.from(image.data.subarray(at, at + 3))).toEqual([255, 0, 0]);
        expect(image.data[at - image.info.channels + 1]).toBe(255);
      }
    } finally {
      await page.close();
    }
  });
  it.each([false, true])("uses only the image Mono bytes for 2ch (imported=%s)", async (imported) => {
    const source = svg(face(), imported);
    const page = await browser.newPage({ viewport: { width: 190, height: 40 } });
    try {
      const el = fixture(source);
      await captureImageSvgFonts(page, [el]);
      expect(el.imageOwnFonts?.faces).toHaveLength(1);
      expect(await page.evaluate(() => document.fonts.size)).toBe(0);
      const inlined = inlineImgSvg(source, { ...placement, ownFonts: el.imageOwnFonts });
      expect(inlined).not.toBeNull();
      expect(inlined).toContain("translate(24 0)");
      expect(inlined).toContain("own-Image Face");
      await page.setContent(
        `<body style="margin:0;background:white"><img src="${el.imageSrc}" width="90" height="40"><svg width="90" height="40">${inlined}</svg></body>`,
      );
      const pixels = await sharp(await page.screenshot())
        .raw()
        .toBuffer({ resolveWithObject: true });
      const firstRed = (offset: number): number => {
        for (let x = 0; x < 90; x++) {
          const at = (5 * pixels.info.width + offset + x) * pixels.info.channels;
          if (pixels.data[at] === 255 && pixels.data[at + 1] === 0) return x;
        }
        return -1;
      };
      expect(firstRed(0)).toBe(24);
      expect(firstRed(90)).toBe(24);
    } finally {
      await page.close();
    }
  });

  it("records evidence through the production capture path", async () => {
    const page = await browser.newPage({ viewport: { width: 100, height: 50 } });
    try {
      await page.setContent(
        `<body style="margin:0"><img src="data:image/svg+xml,${encodeURIComponent(svg(face(), true))}"></body>`,
      );
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 100, height: 50 });
      const images: CapturedElement[] = [];
      forEachElement(tree, (el) => {
        if (el.tag === "img") images.push(el);
      });
      expect(images[0].imageOwnFonts?.faces).toHaveLength(1);
      expect(inlineImgSvg(svg(face(), true), { ...placement, ownFonts: images[0].imageOwnFonts })).toContain(
        "translate(24 0)",
      );
    } finally {
      await page.close();
    }
  });

  it("keeps same-named image families isolated and binds evidence to source", async () => {
    const page = await browser.newPage();
    try {
      const a = svg(face(mono));
      const b = svg(face(serif));
      const one = fixture(a);
      const two = fixture(b);
      await captureImageSvgFonts(page, [one, two]);
      const first = inlineImgSvg(a, { ...placement, ownFonts: one.imageOwnFonts });
      const second = inlineImgSvg(b, { ...placement, ownFonts: two.imageOwnFonts });
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(first).not.toBe(second);
      expect(inlineImgSvg(b, { ...placement, ownFonts: one.imageOwnFonts })).toBeNull();
      expect(inlineImgSvg(a, placement)).toBeNull();
      expect(inlineImgSvg(a, { ...placement, ownFonts: one.imageOwnFonts })).toBe(first);
    } finally {
      await page.close();
    }
  });

  it.each(["font-display:optional", "font-display:fallback", "size-adjust:120%", "font-style:oblique 30deg"])(
    "retains raster for unproven %s",
    async (descriptor) => {
      const page = await browser.newPage();
      try {
        const source = svg(face(mono, descriptor));
        const el = fixture(source);
        await captureImageSvgFonts(page, [el]);
        expect(el.imageOwnFonts).toBeUndefined();
        expect(inlineImgSvg(source, { ...placement, ownFonts: el.imageOwnFonts })).toBeNull();
      } finally {
        await page.close();
      }
    },
  );

  it("rejects incomplete images and invalid bytes even if an installed PS name exists", async () => {
    const page = await browser.newPage();
    try {
      for (const el of [fixture(svg(face()), false), fixture(svg(face(Buffer.from("ArialMT"))))]) {
        await captureImageSvgFonts(page, [el]);
        expect(el.imageOwnFonts).toBeUndefined();
      }
    } finally {
      await page.close();
    }
  });
});
