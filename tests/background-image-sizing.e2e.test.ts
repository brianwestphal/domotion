import { afterAll, describe, expect, it } from "vitest";
import sharp from "sharp";

import {
  captureElementTreeWithWarnings,
  elementTreeToSvg,
  launchChromium,
} from "../src/index.js";
import type { CapturedBackgroundImage } from "../src/capture/types.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

async function rasterDataUrl(
  width: number,
  height: number,
  format: "png" | "jpeg" = "png",
): Promise<string> {
  const image = sharp({
    create: { width, height, channels: 4, background: { r: width, g: height, b: 177, alpha: 1 } },
  });
  const bytes = format === "png" ? await image.png().toBuffer() : await image.jpeg().toBuffer();
  return `data:image/${format};base64,${bytes.toString("base64")}`;
}

const [PNG_1X, PNG_2X, PNG_3X, PNG_DIRECT, JPEG_DIRECT] = await Promise.all([
  rasterDataUrl(20, 10),
  rasterDataUrl(80, 40),
  rasterDataUrl(180, 90),
  rasterDataUrl(30, 20),
  rasterDataUrl(44, 22, "jpeg"),
]);
const ORIENTED_JPEG = `data:image/jpeg;base64,${(await sharp({
  create: { width: 40, height: 20, channels: 3, background: { r: 220, g: 50, b: 47 } },
}).jpeg().withMetadata({ orientation: 6 }).toBuffer()).toString("base64")}`;
const SVG_RATIO = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 3 7"><rect width="3" height="7" fill="red"/></svg>',
)}`;
const SVG_WIDTH_AND_RATIO = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="80" viewBox="0 0 4 2"><rect width="4" height="2" fill="blue"/></svg>',
)}`;

const IMAGE_SET = `image-set(
  url("${PNG_1X}") 1x type("image/png"),
  url("${PNG_2X}") 2x type("image/png"),
  url("${PNG_3X}") 3x type("image/png")
)`;

function selected(tree: Awaited<ReturnType<typeof captureElementTreeWithWarnings>>): CapturedBackgroundImage[] {
  return (tree.tree[0]?.styles.backgroundImages ?? []).filter(
    (entry): entry is CapturedBackgroundImage => entry != null,
  );
}

const env = await (async () => {
  try { return { browser: await launchChromium() }; } catch { return null; }
})();
afterAll(async () => closeBrowserSafely(env?.browser), 15_000);
const describeBrowser = env == null ? describe.skip : describe;

describeBrowser("authoritative URL background image sizing capture", () => {
  for (const row of [
    { dpr: 1, selectedUrl: PNG_1X, decodedWidth: 20, naturalWidth: 25, resolution: 1 },
    { dpr: 2, selectedUrl: PNG_2X, decodedWidth: 80, naturalWidth: 50, resolution: 2 },
  ]) {
    it(`uses Blink's image-set candidate and density at DPR ${row.dpr}`, async () => {
      const context = await env!.browser.newContext({ viewport: { width: 220, height: 140 }, deviceScaleFactor: row.dpr });
      const page = await context.newPage();
      try {
        await page.setContent(`<style>
          #target { width:120px; height:80px; zoom:1.25; background-image:${IMAGE_SET}; background-size:auto; }
        </style><div id="target"></div>`);
        const result = await captureElementTreeWithWarnings(page, "#target", { x: 0, y: 0, width: 220, height: 140 });
        const [record] = selected(result);
        expect(record).toMatchObject({
          source: "image-set",
          selectedUrl: row.selectedUrl,
          selectedResolution: row.resolution,
          selectedType: "image/png",
          decodedImageKind: "bitmap",
          decodedNaturalWidth: row.decodedWidth,
          naturalWidth: row.naturalWidth,
          effectiveZoom: 1.25,
          loadState: "loaded",
          naturalSizingState: "resolved",
        });
        expect(record.naturalHeight).toBe(row.naturalWidth / 2);
        expect(result.tree[0].styles.backgroundIntrinsic).toEqual([
          { w: row.naturalWidth, h: row.naturalWidth / 2 },
        ]);
        const svg = elementTreeToSvg(result.tree, 220, 140);
        expect(svg).toContain(row.selectedUrl);
        expect(svg).not.toContain(row.dpr === 1 ? PNG_2X : PNG_1X);
      } finally {
        await context.close();
      }
    }, 60_000);
  }

  it("records bitmap, ratio-only SVG, independent dimension, orientation, and aligned layers", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 260, height: 160 }, deviceScaleFactor: 1 });
    try {
      await page.setContent(`<style>img { width:7px!important; height:9px!important; image-orientation:from-image!important; }</style>
        <div id="target" style="width:160px;height:100px;zoom:1.25;image-orientation:none;
        background-image:url('${PNG_DIRECT}'),linear-gradient(red,blue),url('${JPEG_DIRECT}'),url('${SVG_RATIO}'),url('${SVG_WIDTH_AND_RATIO}');
        background-size:10px,20px"></div>`);
      const result = await captureElementTreeWithWarnings(page, "#target", { x: 0, y: 0, width: 260, height: 160 });
      const layers = result.tree[0].styles.backgroundImages!;
      expect(layers).toHaveLength(5);
      expect(layers[1]).toBeNull();
      expect(layers.map((entry) => entry?.layerIndex ?? null)).toEqual([0, null, 2, 3, 4]);
      expect(layers[0]).toMatchObject({
        decodedImageKind: "bitmap",
        decodedNaturalWidth: 30, decodedNaturalHeight: 20,
        naturalWidth: 37.5, naturalHeight: 25,
        hasNaturalWidth: true, hasNaturalHeight: true,
        imageOrientation: "none", effectiveZoom: 1.25,
      });
      expect(layers[2]).toMatchObject({
        decodedImageKind: "bitmap",
        decodedNaturalWidth: 44, decodedNaturalHeight: 22,
        naturalWidth: 55, naturalHeight: 27.5,
      });
      expect(layers[3]).toMatchObject({
        decodedImageKind: "svg",
        decodedNaturalWidth: null, decodedNaturalHeight: null,
        naturalWidth: null, naturalHeight: null,
        hasNaturalWidth: false, hasNaturalHeight: false,
        naturalAspectRatio: { width: 3, height: 7 },
      });
      expect(layers[4]).toMatchObject({
        decodedImageKind: "svg",
        decodedNaturalWidth: 80, decodedNaturalHeight: null,
        naturalWidth: 100, naturalHeight: null,
        hasNaturalWidth: true, hasNaturalHeight: false,
        naturalAspectRatio: { width: 4, height: 2 },
      });
      expect(result.warnings.filter((warning) => warning.feature === "background-image")).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("awaits delayed decode and preserves explicit failed-resource state", async () => {
    const context = await env!.browser.newContext({ viewport: { width: 220, height: 140 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const delayedBytes = Buffer.from(PNG_DIRECT.slice(PNG_DIRECT.indexOf(",") + 1), "base64");
    await page.route("http://background.test/**", async (route) => {
      if (route.request().url().endsWith("delayed.png")) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        await route.fulfill({
          status: 200,
          contentType: "image/png",
          headers: { "access-control-allow-origin": "*" },
          body: delayedBytes,
        });
      } else if (route.request().url().endsWith("opaque.png")) {
        await route.fulfill({
          status: 200,
          contentType: "image/png",
          headers: { "access-control-allow-origin": "http://other.test" },
          body: delayedBytes,
        });
      } else {
        await route.abort("failed");
      }
    });
    try {
      await page.route("http://page.test/", async (route) => route.fulfill({
        status: 200,
        contentType: "text/html",
        body: `<div id="target" style="width:120px;height:80px;
          background-image:url('http://background.test/delayed.png'),url('http://background.test/failed.png'),url('http://background.test/opaque.png')"></div>`,
      }));
      await page.goto("http://page.test/", {
        waitUntil: "domcontentloaded",
      });
      const result = await captureElementTreeWithWarnings(page, "#target", { x: 0, y: 0, width: 220, height: 140 });
      expect(result.tree[0].styles.backgroundImages).toMatchObject([
        { decodedImageKind: "bitmap", loadState: "loaded", naturalSizingState: "resolved", decodedNaturalWidth: 30, decodedNaturalHeight: 20 },
        { decodedImageKind: "unknown", loadState: "failed", naturalSizingState: "unavailable", naturalWidth: null, naturalHeight: null },
        { decodedImageKind: "unknown", loadState: "loaded", naturalSizingState: "unavailable", naturalWidth: null, naturalHeight: null },
      ]);
      const warning = result.warnings.find((entry) => entry.feature === "background-image");
      expect(warning?.detail).toContain("failed");
      expect(warning?.detail).toContain("type was not observable");
    } finally {
      await context.close();
    }
  }, 60_000);

  it("applies the captured image-orientation to decoded natural dimensions", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 220, height: 140 }, deviceScaleFactor: 1 });
    try {
      await page.setContent(`<section style="zoom:1.2"><div id="target" style="width:120px;height:80px;zoom:1.25;image-orientation:from-image;background-image:url('${ORIENTED_JPEG}')"></div></section>`);
      const oriented = await captureElementTreeWithWarnings(page, "#target", { x: 0, y: 0, width: 220, height: 140 });
      expect(selected(oriented)[0]).toMatchObject({
        decodedImageKind: "bitmap",
        imageOrientation: "from-image",
        effectiveZoom: 1.5,
        decodedNaturalWidth: 20,
        decodedNaturalHeight: 40,
        naturalWidth: 30,
        naturalHeight: 60,
      });

      await page.locator("#target").evaluate((element) => {
        (element as HTMLElement).style.imageOrientation = "none";
      });
      const unoriented = await captureElementTreeWithWarnings(page, "#target", { x: 0, y: 0, width: 220, height: 140 });
      expect(selected(unoriented)[0]).toMatchObject({
        decodedImageKind: "bitmap",
        imageOrientation: "none",
        effectiveZoom: 1.5,
        decodedNaturalWidth: 40,
        decodedNaturalHeight: 20,
        naturalWidth: 60,
        naturalHeight: 30,
      });
    } finally {
      await page.close();
    }
  }, 60_000);

  it("reselects after mutation and removes every temporary page marker", async () => {
    const context = await env!.browser.newContext({ viewport: { width: 220, height: 140 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    try {
      await page.setContent(`<style>
        #target { width:120px; height:80px; background-image:${IMAGE_SET}; }
      </style><div id="target"></div>`);
      const first = await captureElementTreeWithWarnings(page, "#target", { x: 0, y: 0, width: 220, height: 140 });
      expect(selected(first)[0].selectedUrl).toBe(PNG_2X);
      await page.locator("#target").evaluate((element, url) => {
        (element as HTMLElement).style.backgroundImage = `url("${url}")`;
      }, JPEG_DIRECT);
      const second = await captureElementTreeWithWarnings(page, "#target", { x: 0, y: 0, width: 220, height: 140 });
      expect(selected(second)[0]).toMatchObject({
        source: "url",
        selectedUrl: JPEG_DIRECT,
        selectedResolution: 1,
        decodedImageKind: "bitmap",
      });
      expect(await page.evaluate(() => ({
        host: "__domotionBackgroundImageTargets" in globalThis,
        key: "__domotionBackgroundImageKey" in document.querySelector("#target")!,
        record: "__domotionBackgroundImages" in document.querySelector("#target")!,
      }))).toEqual({ host: false, key: false, record: false });
    } finally {
      await context.close();
    }
  }, 60_000);
});
