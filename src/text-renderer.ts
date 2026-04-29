/**
 * Text Renderer
 *
 * Renders text in SVG using fontkit path outlines for cross-browser identical rendering.
 */

import bidiFactory from "bidi-js";
import { getDecorationMetrics, renderTextAsPath } from "./text-to-path.js";
import type { CapturedElement, TextSegment } from "./dom-to-svg.js";

// ── Rendering helpers ──

function r(n: number): string { return Number(n.toFixed(1)).toString(); }
function esc(s: string): string { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

/**
 * Emit <image> overlays for any per-char raster glyphs the capture layer
 * attached to this segment (SK-1090). These sit on top of the text-path
 * markup and cover the exact pixel region Chrome painted for the color-
 * bitmap codepoint (emoji, U+2713-family, etc.). Returns "" when the
 * segment has no raster glyphs or none of them have a resolved dataUri.
 */
function rasterGlyphOverlays(seg: TextSegment, clipId: string): string {
  if (seg.rasterGlyphs == null || seg.rasterGlyphs.length === 0) return "";
  const out: string[] = [];
  for (const g of seg.rasterGlyphs) {
    if (g.dataUri == null) continue;
    out.push(`<image href="${g.dataUri}" x="${r(g.rect.x)}" y="${r(g.rect.y)}" width="${r(g.rect.width)}" height="${r(g.rect.height)}" preserveAspectRatio="none" clip-path="url(#${clipId})"/>`);
  }
  return out.join("");
}

/**
 * Emit SVG lines for CSS text-decoration-line (underline / line-through /
 * overline). Each segment gets its own line anchored to the segment's box —
 * this matches how browsers paint decoration on each inline box instead of
 * one continuous line across gaps. Returns "" when no decoration applies.
 *
 * `baselineY` is the segment's baseline in viewport coords. Position and
 * thickness come from the font's `post.underlinePosition` / `underlineThickness`
 * (underline) and `OS/2.yStrikeoutPosition` / `yStrikeoutSize` (line-through)
 * tables — the same metrics Chromium consults — so placement matches the
 * browser within ~0.5px instead of relying on fontSize fractions (SK-1236).
 */
function renderTextDecoration(
  textDecorationLine: string | undefined,
  decorationColor: string,
  style: string | undefined,
  segX: number, baselineY: number, segWidth: number,
  fontSize: number, fontFamily: string, fontWeight: string | number, fontStyle: string | undefined,
): string {
  if (textDecorationLine == null || textDecorationLine === "none" || textDecorationLine === "") return "";
  const m = getDecorationMetrics(fontFamily, fontSize, fontWeight, fontStyle);
  const lines: string[] = [];
  const has = (k: string) => textDecorationLine.includes(k);
  const dash = (thick: number) => style === "dashed" ? ` stroke-dasharray="${thick * 2} ${thick * 2}"`
    : style === "dotted" ? ` stroke-dasharray="${thick} ${thick}"` : "";
  if (has("underline")) {
    const y = baselineY + m.underlineOffsetY;
    const t = m.underlineThickness;
    lines.push(`<line x1="${r(segX)}" y1="${r(y)}" x2="${r(segX + segWidth)}" y2="${r(y)}" stroke="${decorationColor}" stroke-width="${r(t)}"${dash(t)}/>`);
  }
  if (has("line-through")) {
    const y = baselineY - m.strikeoutOffsetY;
    const t = m.strikeoutThickness;
    lines.push(`<line x1="${r(segX)}" y1="${r(y)}" x2="${r(segX + segWidth)}" y2="${r(y)}" stroke="${decorationColor}" stroke-width="${r(t)}"${dash(t)}/>`);
  }
  if (has("overline")) {
    const y = baselineY - m.overlineOffsetY;
    const t = m.overlineThickness;
    lines.push(`<line x1="${r(segX)}" y1="${r(y)}" x2="${r(segX + segWidth)}" y2="${r(y)}" stroke="${decorationColor}" stroke-width="${r(t)}"${dash(t)}/>`);
  }
  return lines.join("");
}

const _bidi = bidiFactory();
// Quick test for any RTL code point (Hebrew + Arabic + Syriac + Thaana etc.).
const _RTL_RE = /[֐-ࣿיִ-ﻼ]/;

/**
 * Apply BiDi paired-bracket mirroring. Capture preserves chars in DOM/logical
 * order with each char's visual x in xOffsets — positioning is already done
 * by Chrome, so we only need to mirror paired brackets on RTL embedding
 * levels (so a logical "(" inside an RTL run renders as ")"). We do NOT
 * reorder: passing logical-order text to fontkit lets Arabic pick the
 * correct contextual (initial/medial/final/isolated) forms when the renderer
 * can honor shaping, and when it falls back to per-char isolated rendering
 * the visual order still comes out right because per-char xOffsets already
 * reflect Chrome's BiDi visual layout.
 *
 * paragraphDir comes from the element's CSS `direction` (default 'ltr').
 * Returns the input text with mirror substitutions applied; xOffsets pass
 * through unchanged.
 */
function applyBidi(text: string, xOffsets: number[] | undefined, paragraphDir: "ltr" | "rtl"): { text: string; xOffsets?: number[] } {
  if (!_RTL_RE.test(text) && paragraphDir !== "rtl") return { text, xOffsets };
  const embeddingLevels = _bidi.getEmbeddingLevels(text, paragraphDir);
  // bidi-js's getMirroredCharactersMap is keyed for a post-reorder pipeline
  // and returns empty when we haven't reordered, so apply mirroring directly:
  // any paired bracket at an odd (RTL) embedding level gets swapped.
  let outText = "";
  let anyMirror = false;
  for (let i = 0; i < text.length; i++) {
    const level = embeddingLevels.levels[i];
    if (level % 2 === 1) {
      const m = _bidi.getMirroredCharacter(text[i]);
      if (m != null) { outText += m; anyMirror = true; continue; }
    }
    outText += text[i];
  }
  if (!anyMirror) return { text, xOffsets };
  return { text: outText, xOffsets };
}

interface RenderTextOpts {
  el: CapturedElement;
  idPrefix: string;
  clipId: string;
  fillColor: string;
  /** True when the element has overflow != visible (hidden / clip / scroll /
   *  auto on either axis) and text must be clipped to the content rect. When
   *  false, path-mode text renders without a clip-path so default
   *  `overflow: visible` text can spill past the box edge as Chrome paints. */
  overflowClip?: boolean;
}

/**
 * Render a single-line text element.
 */
export function renderSingleLineText(opts: RenderTextOpts): string {
  const { el, clipId, fillColor } = opts;
  const fontSize = parseFloat(el.styles.fontSize) || 14;
  const fontFamily = el.styles.fontFamily;
  const fontWeight = el.styles.fontWeight;
  const tl = el.textLeft ?? el.x + 4;
  const tt = el.textTop ?? el.y;

  // Path mode: convert to <path> outlines. When the capture layer recorded
  // per-character xOffsets for this single-line segment, pass them through so
  // each glyph is anchored at the exact x Chrome painted (closes per-char
  // drift). Falls back to Chrome's measured width for uniform scaling.
  const singleSeg = (el.textSegments != null && el.textSegments.length === 1) ? el.textSegments[0] : undefined;
  const pathTextRaw = singleSeg != null ? singleSeg.text : el.text;
  const xOffsetsRelRaw = singleSeg?.xOffsets != null ? singleSeg.xOffsets.map((v) => v - tl) : undefined;
  const dir = el.styles.direction === "rtl" ? "rtl" : "ltr";
  const reordered = applyBidi(pathTextRaw, xOffsetsRelRaw, dir);
  const pathText = reordered.text;
  const xOffsetsRel = reordered.xOffsets;
  const features = singleSeg?.fontVariant != null && /\bsmall-caps\b/.test(singleSeg.fontVariant) ? ["smcp"] : undefined;
  const result = renderTextAsPath(pathText, tl, tt, fontSize, fontFamily, fontWeight, fillColor, undefined, el.textWidth, xOffsetsRel, el.styles.fontStyle, el.fontAscent, features);
  if (result != null) {
    const decoColor = (el.styles.textDecorationColor && el.styles.textDecorationColor !== "currentcolor")
      ? el.styles.textDecorationColor : fillColor;
    // baselineY = textTop + fontAscent. Using fontSize here would put the
    // underline ~1px too low (fontSize includes descent; baseline sits at
    // ascent above textTop, not at the line-bottom). DM-265.
    const decoBaselineY = tt + (el.fontAscent ?? fontSize);
    const decoMarkup = renderTextDecoration(el.styles.textDecorationLine, decoColor, el.styles.textDecorationStyle, tl, decoBaselineY, el.textWidth ?? 0, fontSize, fontFamily, fontWeight, el.styles.fontStyle);
    // Per-char raster overlays (SK-1090). Emoji / color-bitmap codepoints in
    // the middle of plain-text runs get stamped on top of the path output.
    const rasterOverlay = singleSeg != null ? rasterGlyphOverlays(singleSeg, clipId) : "";
    // Wrap the path-mode output in the element's clip-path only when the
    // element actually overflow-clips (DM-305). Default `overflow: visible`
    // lets text extend past the box edge, so the unconditional clip from
    // an earlier draft over-cut text on `word-wrap: break-word` paragraphs
    // whose last char measured a fraction of a px past `el.x + el.width`.
    if (opts.overflowClip) {
      return `<g clip-path="url(#${clipId})">${result}${decoMarkup}${rasterOverlay}</g>`;
    }
    return `${result}${decoMarkup}${rasterOverlay}`;
  }

  // Fallback to CSS <text> if path rendering fails
  const ff = fontFamily.replace(/"/g, "'");
  const lsCss = el.styles.letterSpacing !== "normal" && el.styles.letterSpacing !== "0px"
    ? `letter-spacing:${el.styles.letterSpacing};` : "";
  const baseStyle = `font-family:${ff};font-size:${r(fontSize)}px;font-weight:${fontWeight};font-kerning:normal;font-optical-sizing:auto;${lsCss}`;

  const textY = (el.textTop != null && el.textHeight != null && el.textHeight > 0)
    ? el.textTop + el.textHeight / 2 : el.y + el.height / 2;

  // Detect centered text (badges, buttons with symmetric padding)
  const tw = el.textWidth ?? 0;
  const leftGap = tl - el.x;
  const rightGap = (el.x + el.width) - (tl + tw);
  const minGap = Math.min(leftGap, rightGap);
  const isCentered = tw > 0 && leftGap > 2 && rightGap > 2
    && Math.abs(leftGap - rightGap) < Math.max(2, minGap * 0.3);

  if (isCentered) {
    const cx = el.x + el.width / 2;
    return `<text x="${r(cx)}" y="${r(textY)}" text-anchor="middle" dominant-baseline="central" fill="${fillColor}" style="${baseStyle}" clip-path="url(#${clipId})">${esc(el.text)}</text>`;
  }
  return `<text x="${r(tl)}" y="${r(textY)}" dominant-baseline="central" fill="${fillColor}" style="${baseStyle}" clip-path="url(#${clipId})">${esc(el.text)}</text>`;
}

/**
 * Render multi-segment text (mixed content like: <p>Text <code>x</code> more</p>).
 */
export function renderMultiSegmentText(opts: RenderTextOpts, segments: TextSegment[]): string {
  const { el, clipId, fillColor } = opts;
  const elFontSize = parseFloat(el.styles.fontSize) || 14;
  const fontFamily = el.styles.fontFamily;
  const elFontWeight = el.styles.fontWeight;
  const parts: string[] = [];

  const dir = el.styles.direction === "rtl" ? "rtl" : "ltr";
  const decoLine = el.styles.textDecorationLine;
  const decoColor = (el.styles.textDecorationColor && el.styles.textDecorationColor !== "currentcolor")
    ? el.styles.textDecorationColor : fillColor;
  const decoStyle = el.styles.textDecorationStyle;
  for (const seg of segments) {
    // Color-bitmap glyph fallback (SK-1058): CAPTURE_SCRIPT marked this
    // segment with a Playwright screenshot of Chrome's actual raster (e.g.
    // U+2713 ✓, which Chrome paints via Apple Color Emoji's sbix bitmap that
    // fontkit can't convert to <path>). Stamp the PNG directly at the
    // segment's layout box. Skip the path pipeline — the rasterRect was sized
    // to the full line box, so y/height here use that same rect so the image
    // lands exactly where Chrome painted it.
    if (seg.rasterDataUri != null && seg.rasterRect != null) {
      parts.push(`<image href="${seg.rasterDataUri}" x="${r(seg.rasterRect.x)}" y="${r(seg.rasterRect.y)}" width="${r(seg.rasterRect.width)}" height="${r(seg.rasterRect.height)}" preserveAspectRatio="none" clip-path="url(#${clipId})"/>`);
      continue;
    }
    // Per-segment overrides from ::before / ::after pseudos (color, fontSize,
    // fontWeight). Fall back to the element's styles when the segment has no
    // override. This is how we render the .flag::before red, the li[data-badge]
    // purple-bold, the abbr[title]::after blue-and-smaller, etc. ::first-line
    // uses the same mechanism — the first segment of a paragraph inherits a
    // pseudo-style override from CAPTURE_SCRIPT (DM-294).
    const segColor = seg.color ?? fillColor;
    const segFontSize = seg.fontSize ?? elFontSize;
    const segFontWeight = seg.fontWeight ?? elFontWeight;
    const segFontStyle = seg.fontStyle ?? el.styles.fontStyle;
    // `font-variant: small-caps` resolves to the OpenType `smcp` feature.
    // CSS spec maps small-caps to smcp only (uppercase letters stay full
    // height); font-variant-caps: all-small-caps would add c2sc but isn't
    // covered by the shorthand we read here. (DM-294)
    const segFeatures = seg.fontVariant != null && /\bsmall-caps\b/.test(seg.fontVariant) ? ["smcp"] : undefined;
    // Pass per-char xOffsets through (relative to seg.x) so multi-line wrapped
    // text anchors glyphs at the exact Chromium-measured positions.
    const xOffsetsRelRaw = seg.xOffsets != null ? seg.xOffsets.map((v) => v - seg.x) : undefined;
    const reordered = applyBidi(seg.text, xOffsetsRelRaw, dir);
    const segAscent = seg.fontAscent ?? el.fontAscent;
    const result = renderTextAsPath(reordered.text, seg.x, seg.y, segFontSize, fontFamily, segFontWeight, segColor, undefined, undefined, reordered.xOffsets, segFontStyle, segAscent, segFeatures);
    if (result != null) { parts.push(result); }
    else {
      // Fallback to CSS <text> if path rendering fails
      const ff = fontFamily.replace(/"/g, "'");
      const baseStyle = `font-family:${ff};font-size:${r(segFontSize)}px;font-weight:${segFontWeight};font-kerning:normal;font-optical-sizing:auto;`;
      const sy = seg.y + seg.height / 2;
      parts.push(`<text x="${r(seg.x)}" y="${r(sy)}" dominant-baseline="central" fill="${segColor}" style="${baseStyle}" clip-path="url(#${clipId})">${esc(seg.text)}</text>`);
    }
    const segDecoBaselineY = seg.y + (segAscent ?? segFontSize);
    const decoMarkup = renderTextDecoration(decoLine, decoColor, decoStyle, seg.x, segDecoBaselineY, seg.width, segFontSize, fontFamily, segFontWeight, el.styles.fontStyle);
    if (decoMarkup !== "") parts.push(decoMarkup);
    // Per-char raster overlays (SK-1090). Emoji inline with path-rendered
    // text get their actual Chrome-painted pixels stamped over the position.
    const rasterOverlay = rasterGlyphOverlays(seg, clipId);
    if (rasterOverlay !== "") parts.push(rasterOverlay);
  }

  // Wrap the multi-segment output in the element's clip-path only when the
  // element actually overflow-clips (DM-305) — see comment in
  // renderSingleLineText for why an unconditional clip is wrong.
  if (opts.overflowClip) {
    return `<g clip-path="url(#${clipId})">${parts.join("\n")}</g>`;
  }
  return parts.join("\n");
}

/**
 * Render multi-line text (pre blocks).
 */
export function renderMultiLineText(opts: RenderTextOpts): string {
  const { el, clipId, fillColor } = opts;
  const fontSize = parseFloat(el.styles.fontSize) || 14;
  const fontFamily = el.styles.fontFamily;
  const fontWeight = el.styles.fontWeight;
  const lhStr = el.styles.lineHeight;
  const lhParsed = parseFloat(lhStr);
  const lineHeight = (lhStr !== "normal" && !isNaN(lhParsed) && lhParsed > 0) ? lhParsed : fontSize * 1.2;
  const startX = el.textLeft ?? el.x + 4;
  const startY = el.textTop ?? el.y + 4;
  const outerEsc = esc;

  const parts: string[] = [];
  parts.push(`<g clip-path="url(#${clipId})" role="img" aria-label="${outerEsc(el.text)}"><title>${outerEsc(el.text)}</title>`);

  // SK-1235: prefer captured text segments — each carries Chromium-measured
  // per-char xOffsets that close the same fontkit-vs-HarfBuzz drift SK-1234
  // closed for inputs. Each segment is one visual line, so iterating segments
  // also matches Chromium's actual line-wrapping decisions for the cases
  // where source HTML has internal `\n` whitespace that the browser collapses
  // (those land here with a single segment and a \n-bearing el.text — splitting
  // on `\n` would emit a phantom second line below the captured one).
  if (el.textSegments != null && el.textSegments.length > 0) {
    const dir = el.styles.direction === "rtl" ? "rtl" : "ltr";
    for (const seg of el.textSegments) {
      const xOffsetsRelRaw = seg.xOffsets != null ? seg.xOffsets.map((v) => v - seg.x) : undefined;
      const reordered = applyBidi(seg.text, xOffsetsRelRaw, dir);
      const segFontSize = seg.fontSize ?? fontSize;
      const segFontWeight = seg.fontWeight ?? fontWeight;
      const segColor = seg.color ?? fillColor;
      const segAscent = seg.fontAscent ?? el.fontAscent;
      const result = renderTextAsPath(reordered.text, seg.x, seg.y, segFontSize, fontFamily, segFontWeight, segColor, undefined, undefined, reordered.xOffsets, el.styles.fontStyle, segAscent);
      if (result != null) parts.push(`  ${result}`);
    }
  } else {
    const lines = el.text.split("\n");
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      if (line === "") continue;
      const lineY = startY + li * lineHeight;
      const result = renderTextAsPath(line, startX, lineY, fontSize, fontFamily, fontWeight, fillColor, undefined, undefined, undefined, el.styles.fontStyle, el.fontAscent);
      if (result != null) parts.push(`  ${result}`);
    }
  }
  parts.push("</g>");
  return parts.join("\n");
}

/**
 * Render input/textarea text.
 */
export function renderInputText(opts: RenderTextOpts): string {
  const { el, clipId, fillColor } = opts;
  // Textarea content was rasterized via page.screenshot (SK-1108) — stamp the
  // PNG at the content rect and skip the path pipeline. This bypasses our
  // missing word-wrap implementation and delivers pixel-perfect Chrome
  // rendering of the textarea's laid-out value.
  if (el.elementRaster != null && el.elementRaster.dataUri != null) {
    const er = el.elementRaster;
    return `<image href="${er.dataUri}" x="${r(er.x)}" y="${r(er.y)}" width="${r(er.width)}" height="${r(er.height)}" preserveAspectRatio="none" clip-path="url(#${clipId})"/>`;
  }
  const fontSize = parseFloat(el.styles.fontSize) || 14;
  const fontFamily = el.styles.fontFamily;
  const fontWeight = el.styles.fontWeight;
  const textX = el.textLeft ?? el.x + 4;
  const tt = el.textTop ?? el.y;

  // Placeholder text is painted in the ::placeholder color (muted gray by
  // default), not the user-typed text color. CAPTURE_SCRIPT sets this when
  // the input value is empty and a placeholder= attribute is present. CSS
  // lets ::placeholder also override font-style / font-weight independently
  // (purple italic placeholder, etc.). See SK-1097 / SK-1100 / SK-1099.
  const textColor = el.isPlaceholderText && el.placeholderColor != null ? el.placeholderColor : fillColor;
  const textFontStyle = el.isPlaceholderText && el.placeholderFontStyle != null ? el.placeholderFontStyle : el.styles.fontStyle;
  const textFontWeight = el.isPlaceholderText && el.placeholderFontWeight != null ? el.placeholderFontWeight : fontWeight;
  // Per-char xOffsets captured via DOM probe (SK-1234) — anchors each glyph
  // at the position Chromium's HarfBuzz shaping would paint. Falls back to
  // fontkit native advances when the probe wasn't run (e.g. for textarea,
  // which still uses the SK-1108 element raster path).
  const xOffsetsRel = el.inputXOffsets != null
    ? el.inputXOffsets.map((v) => v - textX) : undefined;
  const result = renderTextAsPath(el.text, textX, tt, fontSize, fontFamily, textFontWeight, textColor, undefined, undefined, xOffsetsRel, textFontStyle, el.fontAscent);
  // Clip the path-rendered text to the input's content rect so values that
  // overflow the visible width (common on readonly inputs with long text or
  // any input narrower than its value) are truncated like Chrome paints
  // them, not extending past the right border. DM-245.
  if (result != null) return `<g clip-path="url(#${clipId})">${result}</g>`;

  // Fallback to CSS <text> if path rendering fails
  const textY = (el.textTop != null && el.textHeight != null && el.textHeight > 0)
    ? el.textTop + el.textHeight / 2 : el.y + el.height / 2;
  const ff = fontFamily.replace(/"/g, "'");
  const baseStyle = `font-family:${ff};font-size:${r(fontSize)}px;font-weight:${fontWeight};font-kerning:normal;font-optical-sizing:auto;`;

  return `<text x="${r(textX)}" y="${r(textY)}" dominant-baseline="central" fill="${textColor}" style="${baseStyle}" clip-path="url(#${clipId})">${esc(el.text)}</text>`;
}
