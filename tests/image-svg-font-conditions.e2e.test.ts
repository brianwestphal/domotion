import { readFileSync } from "node:fs";
import type { Browser, Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchChromium } from "../src/capture/index.js";
import { fontSourceEntries, witnessRequest } from "../src/capture/image-svg-fonts.js";
import { captureImageSvgSupports } from "../src/capture/image-svg-supports.js";
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
const face = (src: string): string => `@font-face{font-family:'Image Face';src:${src}}`;
const svg = (css: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="90" height="40" style="font:20px 'Image Face',monospace;transform:translateX(2ch)"><style>${css}</style><rect width="10" height="10" fill="red"/><text x="0" y="36">Rag 0</text></svg>`;
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

/** The render-side placement for a captured fixture (as element-tree-to-svg builds it). */
const placed = (el: CapturedElement, size = { w: 90, h: 40 }) => ({
  ...placement,
  ...size,
  ownFonts: el.imageOwnFonts,
  supportsConditions: el.imageSvgSupports,
});

async function withPage<T>(run: (page: Page) => Promise<T>): Promise<T> {
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  try {
    return await run(page);
  } finally {
    await page.close();
  }
}

/** Capture through the production supports-then-fonts order. */
async function capture(page: Page, source: string): Promise<CapturedElement> {
  const el = fixture(source);
  await captureImageSvgSupports(page, [el]);
  return el;
}

describe("conditional image @font-face groups", () => {
  it.each([
    ["@media true for the 90px image viewport", `@media (max-width: 300px){${face(data(mono))}}`],
    ["@supports true", `@supports (display: grid){${face(data(mono))}}`],
    // A later face in a false group would win the capability group if it
    // were active; the 1024px embedding page must not decide the media query.
    ["@media false only in the image viewport", `${face(data(mono))}@media (min-width: 900px){${face(data(serif))}}`],
    ["@supports false", `${face(data(mono))}@supports (display: no-such){${face(data(serif))}}`],
  ])("admits the faces Chromium activates: %s", async (_name, css) => {
    await withPage(async (page) => {
      const source = svg(css);
      const el = await capture(page, source);
      expect(el.imageOwnFonts?.faces.map((f) => f.sha256)).toEqual([imageFontDigest(mono)]);
      expect(inlineImgSvg(source, placed(el))).toContain("translate(24 0)");
    });
  });

  it("negative control: a wrong condition decision moves the witness off 'painted'", async () => {
    await withPage(async (page) => {
      const source = svg(`${face(data(mono))}@media (min-width: 900px){${face(data(serif))}}`);
      const entry = (bytes: Buffer) => ({
        entries: fontSourceEntries(`url("data:font/ttf;base64,${bytes.toString("base64")}")`)!,
        selected: 0,
      });
      const box = { width: 90, height: 40 };
      const right = witnessRequest(source, source, [entry(mono), null], box)!;
      const wrong = witnessRequest(source, source, [entry(mono), entry(serif)], box)!;
      expect(await witnessImageFonts(page, [right, wrong])).toEqual(["painted", "other"]);
    });
  });

  it("re-decides media at render time and keeps raster for a different image viewport", async () => {
    await withPage(async (page) => {
      const source = svg(`@media (max-width: 300px){${face(data(mono))}}`);
      const el = await capture(page, source);
      expect(el.imageOwnFonts?.viewport).toEqual({ w: 90, h: 40 });
      expect(inlineImgSvg(source, placed(el, { w: 400, h: 40 }))).toBeNull();
    });
  });

  it("keeps an environment media feature the capture did not record raster", async () => {
    await withPage(async (page) => {
      const source = svg(`@media (prefers-color-scheme: dark){${face(data(mono))}}`);
      const el = await capture(page, source);
      expect(el.imageOwnFonts).toBeUndefined();
    });
  });
});

describe("local() sources in an SVG image", () => {
  it("skips a local() name the host lacks to the next source", async () => {
    await withPage(async (page) => {
      const source = svg(face(`local("Domotion No Such Font Zz"), ${data(mono)}`));
      const el = await capture(page, source);
      expect(el.imageOwnFonts?.faces[0].sha256).toBe(imageFontDigest(mono));
      expect(inlineImgSvg(source, placed(el))).toContain("translate(24 0)");
    });
  });

  // Host inventory: the first of these unique names the host's FontCache
  // matches (macOS: Helvetica; Windows: Arial; the Playwright Linux image
  // ships Liberation, not DejaVu).
  const candidates = ["Helvetica", "Arial", "Liberation Sans", "DejaVu Sans", "Noto Sans", "FreeSans"];
  it("keeps raster when a host local() face precedes the data source", async (context) => {
    await withPage(async (page) => {
      const hostFace = await page.evaluate(async (names) => {
        for (const name of names)
          if (
            await new FontFace("probe", `local("${name}")`).load().then(
              () => true,
              () => false,
            )
          )
            return name;
        return null;
      }, candidates);
      if (hostFace == null) {
        context.skip(`no host local() face among ${candidates.join(", ")}`);
        return;
      }
      const source = svg(face(`local("${hostFace}"), ${data(mono)}`));
      const el = await capture(page, source);
      expect(el.imageOwnFonts).toBeUndefined();
      // The image paints the host face, which is neither reference.
      const entries = fontSourceEntries(
        `local("${hostFace}"), url("data:font/ttf;base64,${mono.toString("base64")}")`,
      )!;
      const request = witnessRequest(source, source, [{ entries, selected: 1 }], { width: 90, height: 40 })!;
      expect(await witnessImageFonts(page, [request])).toEqual(["other"]);
    });
  });
});
