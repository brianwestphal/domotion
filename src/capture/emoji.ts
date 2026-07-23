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
import sharp from "sharp";
import type { CapturedElement } from "./types.js";
import { clipRectForScreenshot } from "./clip-rect.js";
import { forEachElement } from "../tree-ops/for-each-element.js";

const APPLE_COLOR_EMOJI_PATH = "/System/Library/Fonts/Apple Color Emoji.ttc";
let _aceFont: any = null;
let _aceFontLoaded = false;
// Available sbix strikes on macOS Apple Color Emoji.ttc.
const SBIX_STRIKES = [20, 26, 32, 40, 48, 52, 64, 96, 160] as const;
const _sbixCache = new Map<string, { buf: Buffer; ppem: number } | null>();

/**
 * Reset the process-global emoji caches — the opened Apple Color Emoji font and
 * the extracted sbix-bitmap cache. These are process-stable (the system font
 * doesn't change between renders), so this isn't needed per-generation; it
 * exists for convention parity with `clearEmbeddedImageCaches()` and for test
 * isolation / forcing a re-open. DM-1435.
 */
export function clearEmojiCaches(): void {
  _aceFont = null;
  _aceFontLoaded = false;
  _sbixCache.clear();
}
// Only take the sbix path when the glyph rect is roughly emoji-shaped (wide
// enough relative to its height). Narrow rects are usually text-presentation
// dingbats / partial clusters where the page-screenshot fallback is safer.
const EMOJI_SBIX_MIN_ASPECT = 0.4;

function loadAppleColorEmojiFont(): any {
  if (_aceFontLoaded) return _aceFont;
  _aceFontLoaded = true;
  if (process.platform !== "darwin" || !existsSync(APPLE_COLOR_EMOJI_PATH)) return null;
  try {
    const opened = (fontkit as any).openSync(APPLE_COLOR_EMOJI_PATH);
    if (opened == null) {
      _aceFont = null;
    } else {
      _aceFont = opened.fonts != null ? opened.fonts[0] : opened;
    }
  } catch {
    _aceFont = null;
  }
  return _aceFont;
}

function extractEmojiBitmap(codepoint: number, paintedWidthPx: number): { buf: Buffer; ppem: number } | null {
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
  let result: { buf: Buffer; ppem: number } | null = null;
  try {
    const g = font.glyphForCodePoint(codepoint);
    if (g != null && g.id !== 0) {
      try {
        const img = g.getImageForSize(pickedPpem);
        if (img != null && img.data != null && img.data.length > 0) {
          result = { buf: Buffer.isBuffer(img.data) ? img.data : Buffer.from(img.data), ppem: pickedPpem };
        }
      } catch {}
      // Some glyphs only have certain strikes populated — fall through to
      // the largest available if our picked strike came back empty.
      if (result == null) {
        for (let i = SBIX_STRIKES.length - 1; i >= 0; i--) {
          try {
            const img = g.getImageForSize(SBIX_STRIKES[i]);
            if (img != null && img.data != null && img.data.length > 0) {
              result = { buf: Buffer.isBuffer(img.data) ? img.data : Buffer.from(img.data), ppem: SBIX_STRIKES[i] };
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
 * Snap an Apple Color Emoji sbix bitmap to the SQUARE box Chrome actually
 * paints it in.
 *
 * Chrome paints a color-emoji glyph as a square whose side equals the glyph
 * ADVANCE — the captured `Range.getBoundingClientRect()` width, minus any
 * letter-spacing Chrome appends to the right of the advance. Two facts make
 * the advance (not the font size) the correct side:
 *  - At small font sizes Chrome enforces a minimum emoji advance that exceeds
 *    the font size — e.g. a 20px advance at font-size 16 (~1.25×). Sizing the
 *    overlay to the font size painted the emoji ~20% too small (DM-1198: "our
 *    emojis seem a lot smaller").
 *  - The sbix PNG is a full square bitmap (the emoji fills a square em), so
 *    drawing it into an advance × advance box reproduces both full-bleed emoji
 *    and ones with transparent margins (e.g. 📈) without distortion.
 *
 * Geometry:
 *  - Horizontal: the bitmap sits flush at the advance's left (`rect.x`); any
 *    letter-spacing pads to the RIGHT, so no horizontal shift is applied
 *    (DM-919 — the original DM-381 centering pass wrongly shifted it right
 *    whenever letter-spacing > 0).
 *  - Vertical: the square is centered in the captured rect's line box, which
 *    matches Chrome within ~1px across sizes (DM-438 — a 20×17 rect extends
 *    upward to a 20×20 square; DM-801 — a 56×63 rect with 8px letter-spacing
 *    snaps to 48×48).
 */
export function emojiSquareRect(
  rect: { x: number; y: number; width: number; height: number },
  letterSpacing: number,
): { x: number; y: number; width: number; height: number } {
  const ls = Math.max(0, letterSpacing) || 0;
  const side = Math.max(1, rect.width - ls);
  return {
    x: rect.x,
    y: rect.y + (rect.height - side) / 2,
    width: side,
    height: side,
  };
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
// A pixel rect to screenshot + where to stash the resulting data URI. Two kinds
// share the pipeline: segment-level rasterRect (SK-1058) and per-char
// rasterGlyphs (SK-1090).
interface RasterCandidate {
  rect: { x: number; y: number; width: number; height: number };
  key: string;
  setDataUri: (uri: string) => void;
}

type RasterTextSeg = NonNullable<CapturedElement["textSegments"]>[number];
type RasterGlyph = NonNullable<RasterTextSeg["rasterGlyphs"]>[number];

/**
 * Per-rasterGlyph sbix-vs-screenshot decision (the deepest level of the walk in
 * `rasterizeBitmapGlyphs`, extracted to flatten it). Tries Apple Color Emoji's
 * sbix bitmap first (sharper than a 1× page screenshot); on a hit it stamps
 * `g.dataUri` + snaps the rect square and returns. Otherwise it queues a
 * screenshot candidate. Behavior is identical to the former inline block.
 */
/** DM-1728: a stamped sbix overlay whose destination rect may need the
 *  per-strike artwork alignment (see alignSbixRects). */
interface SbixAlignJob {
  g: RasterGlyph;
  cp: number;
  embeddedPpem: number;
}

function queueRasterGlyph(
  g: RasterGlyph,
  seg: RasterTextSeg,
  el: CapturedElement,
  candidates: RasterCandidate[],
  sbixAligns: SbixAlignJob[],
): void {
  // DM-989: ::first-letter chars get a zero-rect rasterGlyph entry whose only
  // role is to suppress the body-text glyph at that index (the styled-first-
  // letter segment paints in front). Skip the screenshot — there's nothing to
  // capture, and Playwright rejects zero-area clips anyway.
  if (g.rect.width === 0 && g.rect.height === 0) return;
  const cp = seg.text.codePointAt(g.charIndex);
  // DM-335: try Apple Color Emoji's sbix table first. Returns the high-DPI
  // bitmap Chrome itself paints from CoreText — sharper than a 1× page
  // screenshot at the same emoji rect. Falls through to the page.screenshot
  // path for codepoints the color font doesn't cover (text-presentation
  // glyphs, regional-indicator pairs, ZWJ sequences) or non-darwin platforms
  // where the .ttc isn't available.
  if (cp != null && g.rect.width > g.rect.height * EMOJI_SBIX_MIN_ASPECT) {
    const sbixPng = extractEmojiBitmap(cp, g.rect.width);
    if (sbixPng != null) {
      g.dataUri = `data:image/png;base64,${sbixPng.buf.toString("base64")}`;
      // sbix bitmaps are square (em-square sized). Chrome paints them centered
      // horizontally on the glyph advance and bottom-aligned to the line-box.
      // The captured rect spans the typographic line-box (advance × line-
      // height), which is bigger than the em-square on either axis when letter-
      // spacing or line-height add slack. DM-438: smiley rendered 20×17 in a
      // 20-wide / 17-tall rect — fixed by extending the rect upward to 20×20.
      // DM-801: at font-size 48 with letter-spacing 8, the rect was 56×63, so
      // emoji painted vertically stretched; snap to fontSize × fontSize
      // centered horizontally on the rect's advance and bottom-aligned (falls
      // back to max(w,h) when fontSize isn't carried on the segment).
      const ls = parseFloat(el.styles.letterSpacing ?? "") || 0;
      const sq = emojiSquareRect(g.rect, ls);
      g.rect.x = sq.x;
      g.rect.y = sq.y;
      g.rect.width = sq.width;
      g.rect.height = sq.height;
      // DM-1728: the embedded (high-res) strike's artwork can sit at a
      // different position inside its frame than the strike Chrome actually
      // paints from at this size — queue the rect for ink-bbox alignment.
      sbixAligns.push({ g, cp, embeddedPpem: sbixPng.ppem });
      return;
    }
  }
  // Include rect width+height (rounded) in the dedupe key so a ::first-letter
  // raster of the letter "F" doesn't collide with a regular-sized "F" elsewhere
  // (different render sizes need different screenshots). See SK-1114.
  const w = Math.round(g.rect.width);
  const h = Math.round(g.rect.height);
  candidates.push({
    rect: g.rect,
    key: `glyph|${cp}|${seg.color ?? ""}|${seg.fontSize ?? ""}|${seg.fontWeight ?? ""}|${w}x${h}`,
    setDataUri: (uri) => { g.dataUri = uri; },
  });
}

/** DM-1728: pixel ink bbox of an RGBA buffer (alpha > 16). Null when fully
 *  transparent. */
interface InkBox { minX: number; minY: number; maxX: number; maxY: number }
export function scanInk(data: Buffer | Uint8Array, width: number, height: number): InkBox | null { // exported for unit tests
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 16) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX >= 0 ? { minX, minY, maxX, maxY } : null;
}

/**
 * DM-1728: self-calibrate each stamped sbix overlay against Chrome's ACTUAL
 * painted pixels.
 *
 * Apple hand-tunes the emoji artwork PER STRIKE — the same glyph can sit at a
 * different position inside the bitmap frame at different ppem (U+1F6F7 sled:
 * ink starts at 5/32 of the 32-ppem frame but 18/96 of the 96-ppem frame;
 * U+1F684 train: 10/32 vs 23/96), and some glyphs are outright REDRAWN
 * between strikes (U+1F6CE bellhop bell). Chrome paints the strike matching
 * the render size 1:1 over the advance square; we embed a HIGHER-res strike
 * (≥64 ppem — DM-335, for sharpness through SVG rasterization) stretched over
 * the same square, which lands strike-tuned artwork 1-3px off (the only
 * remaining regions in the 7 emoji unicode-block fixtures). Predicting
 * CoreText's strike choice proved unreliable, so calibrate against the truth:
 *
 * 1. Screenshot the advance square (transparent background, deduped per
 *    codepoint + size) — Chrome's own paint of this glyph at this size.
 * 2. Compare ink bboxes: if the embedded strike's ink (mapped through the
 *    destination rect) misses Chrome's measured ink by ≥ 0.25px on any edge,
 *    solve the destination rect that aligns them (position-tuned artwork —
 *    sled/train). Sub-quarter-pixel agreement leaves the rect untouched, so
 *    strike-invariant glyphs (the overwhelming majority) stay byte-identical.
 * 3. After alignment, coarsely diff the aligned strike against the screenshot;
 *    when the CONTENT genuinely differs (redrawn-per-strike artwork — bell),
 *    demote the overlay to the screenshot pixels: exact at 1× (the fidelity
 *    target), at the cost of >1× sharpness for that rare glyph.
 */
const SBIX_ALIGN_EPS_PX = 0.25;
// Mean-absolute-RGBA-difference (0-255 scale, union of inked pixels) above
// which the aligned strike is considered a DIFFERENT drawing than Chrome's
// paint. High enough to tolerate resampling softness + a neighbor's
// antialiased sliver at the rect edge; low enough to catch redrawn artwork.
const SBIX_CONTENT_DIFF_THRESHOLD = 16;

async function calibrateSbixOverlays(
  page: Page,
  viewport: { x: number; y: number; width: number; height: number },
  jobs: SbixAlignJob[],
): Promise<void> {
  if (jobs.length === 0) return;
  // Chrome's paint, deduped per (codepoint, rounded size): raw RGBA of the
  // advance-square screenshot.
  const shotCache = new Map<string, { data: Buffer; w: number; h: number } | null>();
  for (const { g, cp, embeddedPpem } of jobs) {
    try {
      const side = g.rect.width;
      const shotKey = `${cp}|${Math.round(side)}`;
      let shot = shotCache.get(shotKey);
      if (shot === undefined) {
        const clip = clipRectForScreenshot(g.rect, viewport);
        try {
          const png = await page.screenshot({ clip, omitBackground: true, type: "png" });
          const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
          shot = { data, w: info.width, h: info.height };
        } catch { shot = null; }
        shotCache.set(shotKey, shot);
      }
      if (shot == null) continue;
      const chromeInk = scanInk(shot.data, shot.w, shot.h);
      if (chromeInk == null) continue;

      // Embedded strike raw pixels + ink bbox (frame == ppem square).
      const strike = _sbixCache.get(`${cp}|${embeddedPpem}`) ?? null;
      if (strike == null) continue;
      const emb = await sharp(strike.buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const embInk = scanInk(emb.data, emb.info.width, emb.info.height);
      if (embInk == null) continue;
      const embW = emb.info.width, embH = emb.info.height;
      const embInkW = embInk.maxX - embInk.minX + 1;
      const embInkH = embInk.maxY - embInk.minY + 1;

      // Chrome ink in viewport coords: the screenshot clip snapped outward
      // to integer PAGE coordinates; convert its origin back to
      // viewport-relative space. (For deduped shots the pixels come from the
      // first occurrence; identical glyph cells share the same fractional
      // offset in practice.)
      const occClip = clipRectForScreenshot(g.rect, viewport);
      const clipX = occClip.x - viewport.x, clipY = occClip.y - viewport.y;
      const targetX = clipX + chromeInk.minX;
      const targetY = clipY + chromeInk.minY;
      const targetW = chromeInk.maxX - chromeInk.minX + 1;
      const targetH = chromeInk.maxY - chromeInk.minY + 1;

      // Where the embedded ink currently lands through the destination rect.
      const sx = g.rect.width / embW, sy = g.rect.height / embH;
      const curX = g.rect.x + embInk.minX * sx;
      const curY = g.rect.y + embInk.minY * sy;
      const curW = embInkW * sx;
      const curH = embInkH * sy;

      const needsAlign = Math.abs(curX - targetX) >= SBIX_ALIGN_EPS_PX + 0.5
        || Math.abs(curY - targetY) >= SBIX_ALIGN_EPS_PX + 0.5
        || Math.abs(curW - targetW) >= SBIX_ALIGN_EPS_PX + 0.75
        || Math.abs(curH - targetH) >= SBIX_ALIGN_EPS_PX + 0.75;
      // (+0.5/+0.75 slack: the screenshot ink is quantized to whole pixels and
      // includes antialiased edges, so exact fractional agreement is not
      // achievable — only real strike-tuning drift (≥1px) should trigger.)

      let rect = g.rect;
      if (needsAlign) {
        const w = targetW / (embInkW / embW);
        const h = targetH / (embInkH / embH);
        rect = {
          x: targetX - (embInk.minX / embW) * w,
          y: targetY - (embInk.minY / embH) * h,
          width: w,
          height: h,
        };
      }

      // Content check on the aligned geometry: resample the strike into the
      // screenshot's pixel grid and mean-diff the union of inked pixels.
      const scaleW = Math.max(1, Math.round(rect.width));
      const scaleH = Math.max(1, Math.round(rect.height));
      const resized = await sharp(strike.buf).resize(scaleW, scaleH, { fit: "fill" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const offX = Math.round(rect.x - clipX), offY = Math.round(rect.y - clipY);
      let sum = 0, n = 0;
      for (let y = 0; y < shot.h; y++) {
        for (let x = 0; x < shot.w; x++) {
          const si = (y * shot.w + x) * 4;
          const rx = x - offX, ry = y - offY;
          const inR = rx >= 0 && ry >= 0 && rx < resized.info.width && ry < resized.info.height;
          const ri = inR ? (ry * resized.info.width + rx) * 4 : -1;
          const aShot = shot.data[si + 3], aEmb = inR ? resized.data[ri + 3] : 0;
          if (aShot > 16 || aEmb > 16) {
            // Alpha-weighted channel difference (transparent → 0 contribution).
            for (let c = 0; c < 3; c++) {
              const vShot = aShot > 16 ? shot.data[si + c] : 255;
              const vEmb = aEmb > 16 ? (inR ? resized.data[ri + c] : 255) : 255;
              sum += Math.abs(vShot - vEmb);
            }
            sum += Math.abs(aShot - aEmb);
            n += 4;
          }
        }
      }
      const meanDiff = n > 0 ? sum / n : 0;
      if (meanDiff > SBIX_CONTENT_DIFF_THRESHOLD) {
        // Redrawn-per-strike artwork: no transform reproduces Chrome's
        // drawing. Use Chrome's own pixels (1×-exact) at the original square.
        const clip = clipRectForScreenshot(g.rect, viewport);
        try {
          const png = await page.screenshot({ clip, omitBackground: true, type: "png" });
          g.dataUri = `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
          g.rect.x = clip.x - viewport.x;
          g.rect.y = clip.y - viewport.y;
          g.rect.width = clip.width;
          g.rect.height = clip.height;
        } catch { /* keep the sbix stamp */ }
        continue;
      }
      if (needsAlign) {
        g.rect.x = rect.x;
        g.rect.y = rect.y;
        g.rect.width = rect.width;
        g.rect.height = rect.height;
      }
    } catch { /* leave this overlay as stamped */ }
  }
}

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
  const candidates: RasterCandidate[] = [];
  const sbixAligns: SbixAlignJob[] = [];
  forEachElement(tree, (el) => {
      // Element-level raster (SK-1108): textarea content region, too
      // involved to word-wrap in the path pipeline. Key on text+size+color so
      // identical textareas dedupe to one screenshot.
      if (el.elementRaster != null) {
        const er = el.elementRaster;
        // DM-936: include text-decoration + text-underline-position in the
        // dedupe key so 3 identical-text `.vert.pos-{left,right,auto}`
        // columns don't collapse to the same screenshot (the underline
        // paints in different places per pos-* but tag+text+color+size
        // alone hashes them all together → wrong-side underline in 2/3
        // of the columns). Same for text-shadow / writing-mode variants.
        // All the decoration keys are typed reads off CapturedStyles now; only
        // the `text-decoration` shorthand isn't captured (just the longhands),
        // so narrow-cast that single fallback read.
        const s = el.styles;
        const tdShorthand = (s as { textDecoration?: string }).textDecoration;
        const tdKey = `${s.textDecorationLine ?? tdShorthand ?? ""}|${s.textUnderlinePosition ?? ""}|${s.textUnderlineOffset ?? ""}|${s.textDecorationStyle ?? ""}|${s.textDecorationColor ?? ""}|${s.textDecorationThickness ?? ""}|${s.textShadow ?? ""}|${s.writingMode ?? ""}`;
        candidates.push({
          rect: { x: er.x, y: er.y, width: er.width, height: er.height },
          key: `el|${el.tag}|${el.text}|${el.styles.color}|${el.styles.fontSize}|${er.width}x${er.height}|${tdKey}`,
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
            for (const g of seg.rasterGlyphs) queueRasterGlyph(g, seg, el, candidates, sbixAligns);
          }
        }
      }
  });
  await calibrateSbixOverlays(page, viewport, sbixAligns);
  if (candidates.length === 0) return;

  const cache = new Map<string, string>();
  for (const cand of candidates) {
    let dataUri = cache.get(cand.key);
    if (dataUri == null) {
      // rect is viewport-relative; page.screenshot clip takes page-absolute
      // CSS pixels, so add vp.x/vp.y back. Snap floor/ceil outward to
      // guarantee the glyph is fully contained (Playwright rejects zero-size
      // clips and clips at integer boundaries anyway).
      const clip = clipRectForScreenshot(cand.rect, viewport);
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
