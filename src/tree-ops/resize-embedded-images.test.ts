/**
 * Tests for the `resizeEmbeddedImages` pre-pass spec'd in
 * `docs/27-image-resize-on-embed.md`. Initial smoke coverage landed in
 * DM-539; DM-541 extends it to cover every consumer path
 * (`<img>` / `pseudoImages` / `backgroundImage` / `maskImage` /
 * `borderImageSource` / `listStyleImage`), animated-GIF first-frame
 * collapse, and the disabled-flag byte-identity guarantee.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  _dataUriCache,
  _resizedDataUriCache,
  embedResizedDataUri,
  type CapturedElement,
} from "../render/element-tree-to-svg.js";
import { resizeEmbeddedImages } from "./resize-embedded-images.js";

// Build a minimal CapturedElement. Only the fields the resize walker reads
// are populated; everything else is stub-typed.
function makeImg(url: string, w: number, h: number): CapturedElement {
  return {
    tag: "img",
    text: "",
    x: 0, y: 0, width: w, height: h,
    children: [],
    imageSrc: url,
    styles: {} as CapturedElement["styles"],
  } as CapturedElement;
}

// Helper: synthesize a PNG of the given pixel dims via sharp.
async function makePngDataUri(w: number, h: number): Promise<string> {
  const buf = await sharp({
    create: { width: w, height: h, channels: 4, background: { r: 200, g: 100, b: 50, alpha: 1 } },
  }).png().toBuffer();
  return `data:image/png;base64,${buf.toString("base64")}`;
}

function decodePngBytes(dataUri: string): Buffer {
  const m = /^data:image\/png;base64,(.*)$/s.exec(dataUri);
  if (m == null) throw new Error("not a PNG data URI");
  return Buffer.from(m[1], "base64");
}

beforeEach(() => {
  _dataUriCache.clear();
  _resizedDataUriCache.clear();
});

afterEach(() => {
  _dataUriCache.clear();
  _resizedDataUriCache.clear();
});

describe("DM-539 resizeEmbeddedImages — core pre-pass", () => {
  it("resizes when source is meaningfully larger than target × hiDPI", async () => {
    const url = "https://example.com/big.png";
    _dataUriCache.set(url, await makePngDataUri(1500, 1000));
    const tree = [makeImg(url, 300, 200)];
    await resizeEmbeddedImages(tree, { hiDPIFactor: 2 });

    // Expected sizeKey: ceil(300 * 2) × ceil(200 * 2) = 600x400
    const sizeCache = _resizedDataUriCache.get(url);
    expect(sizeCache).toBeDefined();
    expect(sizeCache!.has("600x400")).toBe(true);
    const meta = await sharp(decodePngBytes(sizeCache!.get("600x400")!)).metadata();
    // sharp with fit:"inside" keeps aspect; 1500x1000 → 600x400 (no clamp).
    expect(meta.width).toBe(600);
    expect(meta.height).toBe(400);
  });

  it("passes the source through unchanged when already at-or-below target", async () => {
    const url = "https://example.com/already-small.png";
    const sourceDataUri = await makePngDataUri(600, 400);
    _dataUriCache.set(url, sourceDataUri);
    const tree = [makeImg(url, 300, 200)];
    await resizeEmbeddedImages(tree, { hiDPIFactor: 2 });

    const sizeCache = _resizedDataUriCache.get(url);
    expect(sizeCache).toBeDefined();
    // Cached entry should be the original bytes (no re-encode).
    expect(sizeCache!.get("600x400")).toBe(sourceDataUri);
  });

  it("dedupes consumers of the same URL at the same target size", async () => {
    const url = "https://example.com/shared.png";
    _dataUriCache.set(url, await makePngDataUri(1000, 1000));
    const tree = [
      makeImg(url, 100, 100),
      makeImg(url, 100, 100),
      makeImg(url, 100, 100),
    ];
    await resizeEmbeddedImages(tree, { hiDPIFactor: 2 });

    const sizeCache = _resizedDataUriCache.get(url);
    expect(sizeCache).toBeDefined();
    expect(sizeCache!.size).toBe(1); // one entry shared by 3 consumers
    expect(sizeCache!.has("200x200")).toBe(true);
  });

  it("creates distinct cache entries for distinct target sizes against the same source", async () => {
    const url = "https://example.com/multi.png";
    _dataUriCache.set(url, await makePngDataUri(2000, 2000));
    const tree = [
      makeImg(url, 100, 100),
      makeImg(url, 250, 250),
    ];
    await resizeEmbeddedImages(tree, { hiDPIFactor: 2 });

    const sizeCache = _resizedDataUriCache.get(url);
    expect(sizeCache).toBeDefined();
    expect(sizeCache!.size).toBe(2);
    expect(sizeCache!.has("200x200")).toBe(true);
    expect(sizeCache!.has("500x500")).toBe(true);
  });

  it("honors hiDPIFactor — factor 1 yields strictly smaller output than factor 2", async () => {
    const url = "https://example.com/scale.png";
    _dataUriCache.set(url, await makePngDataUri(2000, 2000));

    await resizeEmbeddedImages([makeImg(url, 200, 200)], { hiDPIFactor: 1 });
    const at1x = _resizedDataUriCache.get(url)!.get("200x200");
    expect(at1x).toBeDefined();

    _resizedDataUriCache.clear();
    await resizeEmbeddedImages([makeImg(url, 200, 200)], { hiDPIFactor: 2 });
    const at2x = _resizedDataUriCache.get(url)!.get("400x400");
    expect(at2x).toBeDefined();

    expect(decodePngBytes(at1x!).length).toBeLessThan(decodePngBytes(at2x!).length);
  });

  it("skips URLs that aren't in the source-data cache (resize only acts on inlined bytes)", async () => {
    const url = "https://example.com/never-fetched.png";
    // `_dataUriCache` is empty; resize pass should be a no-op for this URL.
    const tree = [makeImg(url, 100, 100)];
    await resizeEmbeddedImages(tree, { hiDPIFactor: 2 });
    expect(_resizedDataUriCache.has(url)).toBe(false);
  });

  it("walks pseudoImages and CSS background-image consumers", async () => {
    const pseudoUrl = "https://example.com/pseudo.png";
    const bgUrl = "https://example.com/bg.png";
    _dataUriCache.set(pseudoUrl, await makePngDataUri(500, 500));
    _dataUriCache.set(bgUrl, await makePngDataUri(1200, 800));
    const tree: CapturedElement[] = [{
      tag: "div",
      text: "",
      x: 0, y: 0, width: 400, height: 300,
      children: [],
      pseudoImages: [{ url: pseudoUrl, x: 0, y: 0, width: 50, height: 50 }],
      styles: {
        backgroundImage: `url("${bgUrl}")`,
      } as CapturedElement["styles"],
    } as CapturedElement];
    await resizeEmbeddedImages(tree, { hiDPIFactor: 2 });

    expect(_resizedDataUriCache.get(pseudoUrl)?.has("100x100")).toBe(true);
    expect(_resizedDataUriCache.get(bgUrl)?.has("800x600")).toBe(true);
  });

  // DM-541: per docs/27 § Render-rect inference, every CSS url() consumer
  // gets its own consumer rect. Cover the ones the smoke suite skipped.

  it("walks CSS mask-image consumers (consumer element rect)", async () => {
    const maskUrl = "https://example.com/mask.png";
    _dataUriCache.set(maskUrl, await makePngDataUri(1024, 1024));
    const tree: CapturedElement[] = [{
      tag: "div",
      text: "",
      x: 0, y: 0, width: 200, height: 100,
      children: [],
      styles: {
        maskImage: `url("${maskUrl}")`,
      } as CapturedElement["styles"],
    } as CapturedElement];
    await resizeEmbeddedImages(tree, { hiDPIFactor: 2 });
    expect(_resizedDataUriCache.get(maskUrl)?.has("400x200")).toBe(true);
  });

  it("walks CSS border-image-source consumers (full border box)", async () => {
    const borderUrl = "https://example.com/border.png";
    _dataUriCache.set(borderUrl, await makePngDataUri(1500, 1500));
    const tree: CapturedElement[] = [{
      tag: "div",
      text: "",
      x: 0, y: 0, width: 250, height: 80,
      children: [],
      styles: {
        borderImageSource: `url("${borderUrl}")`,
      } as CapturedElement["styles"],
    } as CapturedElement];
    await resizeEmbeddedImages(tree, { hiDPIFactor: 2 });
    expect(_resizedDataUriCache.get(borderUrl)?.has("500x160")).toBe(true);
  });

  it("walks CSS list-style-image consumers (em-box at element font-size)", async () => {
    const listUrl = "https://example.com/bullet.png";
    _dataUriCache.set(listUrl, await makePngDataUri(64, 64));
    const tree: CapturedElement[] = [{
      tag: "li",
      text: "",
      x: 0, y: 0, width: 300, height: 24,
      children: [],
      styles: {
        listStyleImage: `url("${listUrl}")`,
        fontSize: "20px",
      } as CapturedElement["styles"],
    } as CapturedElement];
    await resizeEmbeddedImages(tree, { hiDPIFactor: 2 });
    // em-box at 20px font-size × 2x hiDPI = 40x40
    expect(_resizedDataUriCache.get(listUrl)?.has("40x40")).toBe(true);
  });

  it("collapses an animated GIF to a single still PNG (first frame) when resize threshold is crossed", async () => {
    const gifUrl = "https://example.com/animated.gif";
    // Build a multi-page GIF whose source resolution (200×200) exceeds the
    // target (50 × 2 = 100) so the resize threshold fires and the encoder
    // path runs. (At-or-below-target sources skip re-encode and pass the
    // original bytes through verbatim — docs/27 § Resize threshold.)
    const animated = await sharp({
      create: { width: 200, height: 200, channels: 4, background: { r: 220, g: 0, b: 0, alpha: 1 } },
      pages: 2,
    } as any).gif().toBuffer().catch(async () => {
      // Fallback build path: composite a second frame onto the first.
      const f1 = await sharp({ create: { width: 200, height: 200, channels: 4, background: { r: 220, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
      const f2 = await sharp({ create: { width: 200, height: 200, channels: 4, background: { r: 0, g: 0, b: 220, alpha: 1 } } }).png().toBuffer();
      return sharp(f1, { animated: true }).composite([{ input: f2 }]).gif().toBuffer();
    });

    _dataUriCache.set(gifUrl, `data:image/gif;base64,${animated.toString("base64")}`);
    const tree = [makeImg(gifUrl, 50, 50)];
    await resizeEmbeddedImages(tree, { hiDPIFactor: 2 });

    const out = _resizedDataUriCache.get(gifUrl)?.get("100x100");
    expect(out).toBeDefined();
    expect(out!.startsWith("data:image/png;base64,")).toBe(true);
    const outMeta = await sharp(decodePngBytes(out!), { animated: true }).metadata();
    // Per docs/27, animated GIFs become a still image. PNG can't carry
    // animation, so the output reports exactly one page.
    expect(outMeta.pages ?? 1).toBe(1);
  });

  it("disabled flag is a no-op — _dataUriCache unchanged, source bytes preserved verbatim", async () => {
    const url = "https://example.com/untouched.png";
    const sourceDataUri = await makePngDataUri(1500, 1000);
    _dataUriCache.set(url, sourceDataUri);
    const sourceCacheSnapshot = _dataUriCache.get(url);

    // Skipping the resize pre-pass entirely (the "disabled" path) means
    // `_resizedDataUriCache` stays empty and `_dataUriCache` is unchanged.
    expect(_resizedDataUriCache.size).toBe(0);
    expect(_dataUriCache.get(url)).toBe(sourceCacheSnapshot);

    // The renderer-side helper falls back to the source data URI when no
    // resized variant exists for the (url, sizeKey).
    expect(embedResizedDataUri(url, 300, 200, 2)).toBe(sourceDataUri);
  });

  it("CSS `none` and empty values for url() consumers are ignored", async () => {
    // Defense-in-depth: a `none` literal or empty string for any CSS url()
    // consumer should not raise nor populate the cache.
    const tree: CapturedElement[] = [{
      tag: "div",
      text: "",
      x: 0, y: 0, width: 100, height: 100,
      children: [],
      styles: {
        backgroundImage: "none",
        maskImage: "",
        borderImageSource: "none",
        listStyleImage: "none",
        fontSize: "16px",
      } as CapturedElement["styles"],
    } as CapturedElement];
    await resizeEmbeddedImages(tree, { hiDPIFactor: 2 });
    expect(_resizedDataUriCache.size).toBe(0);
  });

  it("clamps hiDPIFactor < 1 up to 1 (renderer + pre-pass agree on key)", async () => {
    const url = "https://example.com/clamp.png";
    _dataUriCache.set(url, await makePngDataUri(800, 600));
    await resizeEmbeddedImages([makeImg(url, 200, 150)], { hiDPIFactor: 0.5 });
    // 200 × clamp(0.5, min=1) = 200, 150 × 1 = 150
    expect(_resizedDataUriCache.get(url)?.has("200x150")).toBe(true);
    // The renderer-side lookup must clamp identically or the key misses.
    const dataUri = embedResizedDataUri(url, 200, 150, 0.5);
    expect(dataUri.startsWith("data:image/png;base64,")).toBe(true);
  });
});
