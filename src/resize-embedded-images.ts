/**
 * DM-539 — image resize-on-embed pre-pass. See `docs/27-image-resize-on-embed.md`.
 *
 * Runs after `embedRemoteImages` (DM-512) populated `_dataUriCache` with
 * source-resolution bytes. Walks the captured tree to collect every
 * (URL, consumer rect) tuple, resizes the source down to
 * `ceil(consumerW * hiDPIFactor) × ceil(consumerH * hiDPIFactor)` via sharp,
 * re-encodes as PNG, and stashes the result in `_resizedDataUriCache` keyed
 * by `(URL, "${w}x${h}")`. The renderer wiring (DM-540) consumes that cache
 * via `embedResizedDataUri` when the resize flag is enabled.
 *
 * Skips a tuple when the source is already at-or-below target resolution —
 * decoding and re-encoding a same-size image accumulates artifacts (JPEG)
 * and may grow the file (PNG-of-tiny-icon). Skips entirely when the URL
 * isn't in `_dataUriCache` (the resize pass only acts on what
 * `embedRemoteImages` already inlined).
 */

import sharp from "sharp";
import {
  _dataUriCache,
  _resizedDataUriCache,
  type CapturedElement,
} from "./dom-to-svg.js";

export interface ResizeEmbeddedImagesOptions {
  /**
   * Multiplier on each consumer's render rect. Default 2.0 — leaves headroom
   * for retina display / zoom without inlining the full source resolution.
   * Values < 1 are clamped to 1 (going below render rect produces a visibly
   * blurry SVG even at default zoom).
   */
  hiDPIFactor?: number;
}

const DEFAULT_HIDPI_FACTOR = 2;
const MIN_HIDPI_FACTOR = 1;

/**
 * Per-(URL, consumer-rect) downscale pre-pass. Mutates `_resizedDataUriCache`
 * in place; returns nothing. Idempotent: re-running with the same tree and
 * options is a no-op (every tuple's resized PNG is already cached).
 */
export async function resizeEmbeddedImages(
  tree: CapturedElement[],
  options: ResizeEmbeddedImagesOptions = {},
): Promise<void> {
  const hiDPI = Math.max(MIN_HIDPI_FACTOR, options.hiDPIFactor ?? DEFAULT_HIDPI_FACTOR);

  // Collect (URL, sizeKey, w, h) tuples. Only consider URLs that
  // `embedRemoteImages` has already inlined — there's nothing to decode
  // otherwise, and the renderer would fall back to the source URL anyway.
  type Tuple = { url: string; sizeKey: string; w: number; h: number };
  const tuples = new Map<string, Tuple>();
  const consider = (url: string | undefined, w: number, h: number): void => {
    if (url == null || url === "") return;
    if (!_dataUriCache.has(url)) return;
    const tw = Math.max(1, Math.ceil(w * hiDPI));
    const th = Math.max(1, Math.ceil(h * hiDPI));
    const sizeKey = `${tw}x${th}`;
    const dedupeKey = `${url}\n${sizeKey}`;
    if (tuples.has(dedupeKey)) return;
    // Skip if a prior call already cached this size for this URL.
    const sizeCache = _resizedDataUriCache.get(url);
    if (sizeCache != null && sizeCache.has(sizeKey)) return;
    tuples.set(dedupeKey, { url, sizeKey, w: tw, h: th });
  };
  const collectFromCss = (cssVal: string | undefined, consumerW: number, consumerH: number): void => {
    if (cssVal == null || cssVal === "" || cssVal === "none") return;
    const re = /url\(\s*(?:"([^"]+)"|'([^']+)'|([^)\s]+))\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(cssVal)) != null) {
      const u = (m[1] ?? m[2] ?? m[3] ?? "").trim();
      consider(u, consumerW, consumerH);
    }
  };
  const walk = (els: CapturedElement[]): void => {
    for (const el of els) {
      consider(el.imageSrc, el.width, el.height);
      if (el.pseudoImages != null) {
        for (const pi of el.pseudoImages) consider(pi.url, pi.width, pi.height);
      }
      collectFromCss(el.styles.backgroundImage, el.width, el.height);
      collectFromCss(el.styles.maskImage, el.width, el.height);
      // border-image renders to the full border box (== el.width × el.height
      // in our captured rects, since x/y/width/height already cover the
      // border box).
      collectFromCss(el.styles.borderImageSource, el.width, el.height);
      // list-style-image paints in an em-box at the element's font-size.
      // Fall back to 16px if fontSize is missing or unparsable.
      const fontPx = parseFloat(el.styles.fontSize ?? "16") || 16;
      collectFromCss(el.styles.listStyleImage, fontPx, fontPx);
      if (el.children.length > 0) walk(el.children);
    }
  };
  walk(tree);
  if (tuples.size === 0) return;

  // Resize in parallel — each sharp call decodes + resizes + encodes
  // independently. Failures are isolated per-tuple: a corrupt source falls
  // back to the original data URI in the cache so the renderer just emits
  // the source bytes (at source resolution) instead of crashing the capture.
  const tasks = Array.from(tuples.values(), async ({ url, sizeKey, w, h }) => {
    const sourceDataUri = _dataUriCache.get(url);
    if (sourceDataUri == null) return;
    const sourceBytes = decodeDataUri(sourceDataUri);
    if (sourceBytes == null) return;
    try {
      // Resize threshold: skip when the source is already at-or-below the
      // target on both axes. Re-encoding a same-size JPEG/PNG accumulates
      // artifacts (or grows the file when re-encoding a small icon as PNG).
      // Read intrinsic dims from sharp metadata so we don't need to parse
      // headers ourselves.
      const meta = await sharp(sourceBytes).metadata();
      const sw = meta.width ?? 0;
      const sh = meta.height ?? 0;
      if (sw > 0 && sh > 0 && sw <= w && sh <= h) {
        // Source is small enough — keep source bytes. Cache the original
        // data URI under this sizeKey so the renderer's lookup is uniform.
        rememberResized(url, sizeKey, sourceDataUri);
        return;
      }
      // `fit: "inside"` preserves aspect ratio within the target box;
      // `withoutEnlargement: true` is defence-in-depth in case the threshold
      // check above mis-fires.
      const out = await sharp(sourceBytes)
        .resize(w, h, { fit: "inside", withoutEnlargement: true })
        .png({ compressionLevel: 9 })
        .toBuffer();
      // DM-542: if the resized PNG ended up LARGER than the source bytes
      // (PNG-of-photo can outweigh a tightly-compressed source JPEG when
      // the resize ratio is small), keep the source. Otherwise we'd
      // pessimise the SVG size for every photo whose target rect is close
      // to source resolution. Validated empirically against
      // apple-desktop-fold: without this guard the SVG GROWS by ~12.6 %
      // (PNG re-encode of source-resolution photos > source JPEG bytes);
      // with it, the resize pass is a no-op for those tiles and other
      // captures still see their full reduction.
      if (out.length >= sourceBytes.length) {
        rememberResized(url, sizeKey, sourceDataUri);
        return;
      }
      const dataUri = `data:image/png;base64,${out.toString("base64")}`;
      rememberResized(url, sizeKey, dataUri);
    } catch {
      // Per-image failure: fall back to source bytes so the SVG still
      // renders. The renderer's `embedResizedDataUri` lookup will hit the
      // source data URI cached under this sizeKey.
      rememberResized(url, sizeKey, sourceDataUri);
    }
  });
  await Promise.all(tasks);
}

function rememberResized(url: string, sizeKey: string, dataUri: string): void {
  let sizeCache = _resizedDataUriCache.get(url);
  if (sizeCache == null) {
    sizeCache = new Map<string, string>();
    _resizedDataUriCache.set(url, sizeCache);
  }
  sizeCache.set(sizeKey, dataUri);
}

function decodeDataUri(dataUri: string): Buffer | null {
  // `embedRemoteImages` always emits `data:<mime>;base64,<payload>` form.
  // Anything else (a passthrough URL the cache stored verbatim) we ignore —
  // we can't decode source bytes from a non-data: cache entry.
  const m = /^data:[^;]+;base64,(.*)$/s.exec(dataUri);
  if (m == null) return null;
  try {
    return Buffer.from(m[1], "base64");
  } catch {
    return null;
  }
}

// `embedResizedDataUri` lives in `dom-to-svg.ts` next to `embedAsDataUri` so
// the renderer's image-emission paths have a single uniform helper that
// handles file:// lazy-load + cache hits + resized-cache hits in one call.
// See `embedResizedDataUri` in `dom-to-svg.ts` for the renderer-facing API.
