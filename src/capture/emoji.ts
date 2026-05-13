/**
 * Apple Color Emoji `sbix` bitmap extraction + the post-capture pass that
 * walks the captured tree, takes a per-glyph `page.screenshot` for each color-
 * bitmap text segment / per-char emoji rect, and stamps a PNG data URI back
 * on the segment so the renderer can emit an `<image>` in place of the
 * unrenderable text path.
 *
 * Two-tier bitmap source:
 *  1. Apple Color Emoji `sbix` strike (DM-335) — reads the high-DPI PNG that
 *     Chrome's CoreText fallback paints from on macOS, sharper than a 1×
 *     page screenshot at typical 16-20px emoji sizes. macOS-only; falls
 *     through to (2) on Linux/Windows or for codepoints the font doesn't
 *     cover (text-presentation dingbats like ✓✗, regional-indicator pairs,
 *     ZWJ sequences).
 *  2. `page.screenshot` clip (SK-1058) — generic fallback for any pixel rect
 *     the path renderer can't reproduce faithfully.
 */

import { existsSync } from "node:fs";
import type { Page } from "@playwright/test";
import * as fontkit from "fontkit";
import type { CapturedElement } from "./types.js";

const APPLE_COLOR_EMOJI_PATH = "/System/Library/Fonts/Apple Color Emoji.ttc";
let _aceFont: any = null;
let _aceFontLoaded = false;
// Available sbix strikes on macOS Apple Color Emoji.ttc.
const SBIX_STRIKES = [20, 26, 32, 40, 48, 52, 64, 96, 160] as const;
const _sbixCache = new Map<string, Buffer | null>();

function loadAppleColorEmojiFont(): any {
  if (_aceFontLoaded) return _aceFont;
  _aceFontLoaded = true;
  if (process.platform !== "darwin" || !existsSync(APPLE_COLOR_EMOJI_PATH)) return null;
  try {
    const opened = (fontkit as any).openSync(APPLE_COLOR_EMOJI_PATH);
    _aceFont = opened.fonts != null ? opened.fonts[0] : opened;
  } catch {
    _aceFont = null;
  }
  return _aceFont;
}

function extractEmojiBitmap(codepoint: number, paintedWidthPx: number): Buffer | null {
  // Pick the smallest strike that supersamples the painted rect at ~3× —
  // enough to stay crisp through SVG → bitmap rasterization at typical 1-2×
  // DPRs without bloating the file. For an 18-20px painted rect that lands
  // on the 64 ppem strike (~6KB) instead of 160 (~24KB); for a 40px rect it
  // jumps to 160. Floor at 64 so even tiny inline emoji stay legible if the
  // SVG is later upscaled.
  const targetPpem = Math.max(64, paintedWidthPx * 3);
  let pickedPpem = SBIX_STRIKES[SBIX_STRIKES.length - 1];
  for (const p of SBIX_STRIKES) {
    if (p >= targetPpem) { pickedPpem = p; break; }
  }
  const cacheKey = `${codepoint}|${pickedPpem}`;
  if (_sbixCache.has(cacheKey)) return _sbixCache.get(cacheKey)!;
  const font = loadAppleColorEmojiFont();
  if (font == null) { _sbixCache.set(cacheKey, null); return null; }
  let result: Buffer | null = null;
  try {
    const g = font.glyphForCodePoint(codepoint);
    if (g != null && g.id !== 0) {
      try {
        const img = g.getImageForSize(pickedPpem);
        if (img != null && img.data != null && img.data.length > 0) {
          result = Buffer.isBuffer(img.data) ? img.data : Buffer.from(img.data);
        }
      } catch {}
      // Some glyphs only have certain strikes populated — fall through to
      // the largest available if our picked strike came back empty.
      if (result == null) {
        for (let i = SBIX_STRIKES.length - 1; i >= 0; i--) {
          try {
            const img = g.getImageForSize(SBIX_STRIKES[i]);
            if (img != null && img.data != null && img.data.length > 0) {
              result = Buffer.isBuffer(img.data) ? img.data : Buffer.from(img.data);
              break;
            }
          } catch {}
        }
      }
    }
  } catch {}
  _sbixCache.set(cacheKey, result);
  return result;
}

/**
 * For every text segment CAPTURE_SCRIPT flagged with a rasterRect (contains a
 * color-bitmap glyph like U+2713 ✓ or an emoji), ask Playwright for a
 * transparent-background screenshot of that pixel region and embed it back on
 * the segment as a data URI. The renderer then emits an <image> in place of
 * the failed path run. Dedup by (text + color + fontSize + fontWeight) so
 * repeated glyphs (common for list markers, repeating checkmarks, etc.) share
 * a single screenshot. See SK-1058.
 */
export async function rasterizeBitmapGlyphs(
  page: Page,
  tree: CapturedElement[],
  viewport: { x: number; y: number; width: number; height: number },
): Promise<void> {
  // Two kinds of candidates share the pipeline:
  //  - Segment-level rasterRect (SK-1058): the whole pseudo text is a color-
  //    bitmap run; renderer emits one <image> and skips the text path.
  //  - Per-char rasterGlyphs (SK-1090): an emoji in the middle of an
  //    otherwise path-rendered plain-text run; renderer stamps an <image>
  //    over each char on top of the text path.
  interface Candidate {
    rect: { x: number; y: number; width: number; height: number };
    key: string;
    setDataUri: (uri: string) => void;
  }
  const candidates: Candidate[] = [];
  const walk = (els: CapturedElement[]): void => {
    for (const el of els) {
      // Element-level raster (SK-1108): textarea content region, too
      // involved to word-wrap in the path pipeline. Key on text+size+color so
      // identical textareas dedupe to one screenshot.
      if (el.elementRaster != null) {
        const er = el.elementRaster;
        candidates.push({
          rect: { x: er.x, y: er.y, width: er.width, height: er.height },
          key: `el|${el.tag}|${el.text}|${el.styles.color}|${el.styles.fontSize}|${er.width}x${er.height}`,
          setDataUri: (uri) => { er.dataUri = uri; },
        });
      }
      if (el.textSegments != null) {
        for (const seg of el.textSegments) {
          if (seg.rasterRect != null) {
            candidates.push({
              rect: seg.rasterRect,
              key: `seg|${seg.text}|${seg.color ?? ""}|${seg.fontSize ?? ""}|${seg.fontWeight ?? ""}`,
              setDataUri: (uri) => { seg.rasterDataUri = uri; },
            });
          }
          if (seg.rasterGlyphs != null) {
            for (const g of seg.rasterGlyphs) {
              const cp = seg.text.codePointAt(g.charIndex);
              // DM-335: try Apple Color Emoji's sbix table first. Returns
              // the high-DPI bitmap Chrome itself paints from CoreText —
              // sharper than a 1× page screenshot at the same emoji rect.
              // Falls through to the page.screenshot path for codepoints
              // the color font doesn't cover (text-presentation glyphs,
              // regional-indicator pairs, ZWJ sequences) or non-darwin
              // platforms where the .ttc isn't available.
              if (cp != null && g.rect.width > g.rect.height * 0.4) {
                const sbixPng = extractEmojiBitmap(cp, g.rect.width);
                if (sbixPng != null) {
                  g.dataUri = `data:image/png;base64,${sbixPng.toString("base64")}`;
                  // sbix bitmaps are square. The captured rect uses the line-box
                  // height (typically the advance width for emoji) which is
                  // shorter than the advance width — Range.getBoundingClientRect
                  // returns the line box, not the painted ink. Painting the
                  // square bitmap into a non-square rect with preserveAspectRatio
                  // ="none" squishes the glyph vertically (DM-438: smiley emoji
                  // rendered 20×17 instead of 20×20). Chrome paints the bitmap
                  // at em-square aspect with the BOTTOM aligned to the line-box
                  // bottom, so extend the rect upward to a square. Scoped to
                  // sbix-fed glyphs (Apple Color Emoji on macOS) so DM-401/411
                  // /414's flag-emoji regression — driven by page.screenshot's
                  // already-rectangular bitmaps — does not return.
                  if (g.rect.width > g.rect.height) {
                    const bottom = g.rect.y + g.rect.height;
                    g.rect.height = g.rect.width;
                    g.rect.y = bottom - g.rect.width;
                  }
                  continue;
                }
              }
              // Include rect width+height (rounded) in the dedupe key so a
              // ::first-letter raster of the letter "F" doesnt collide with
              // a regular-sized "F" elsewhere on the page (different render
              // sizes need different screenshots). See SK-1114.
              const w = Math.round(g.rect.width);
              const h = Math.round(g.rect.height);
              candidates.push({
                rect: g.rect,
                key: `glyph|${cp}|${seg.color ?? ""}|${seg.fontSize ?? ""}|${seg.fontWeight ?? ""}|${w}x${h}`,
                setDataUri: (uri) => { g.dataUri = uri; },
              });
            }
          }
        }
      }
      if (el.children.length > 0) walk(el.children);
    }
  };
  walk(tree);
  if (candidates.length === 0) return;

  const cache = new Map<string, string>();
  for (const cand of candidates) {
    let dataUri = cache.get(cand.key);
    if (dataUri == null) {
      // rect is viewport-relative; page.screenshot clip takes page-absolute
      // CSS pixels, so add vp.x/vp.y back. Snap floor/ceil outward to
      // guarantee the glyph is fully contained (Playwright rejects zero-size
      // clips and clips at integer boundaries anyway).
      const clip = {
        x: Math.max(0, Math.floor(cand.rect.x + viewport.x)),
        y: Math.max(0, Math.floor(cand.rect.y + viewport.y)),
        width: Math.max(1, Math.ceil(cand.rect.width)),
        height: Math.max(1, Math.ceil(cand.rect.height)),
      };
      try {
        const buf = await page.screenshot({ clip, omitBackground: true, type: "png" });
        dataUri = `data:image/png;base64,${Buffer.from(buf).toString("base64")}`;
        cache.set(cand.key, dataUri);
      } catch {
        continue;
      }
    }
    cand.setDataUri(dataUri);
  }
}
