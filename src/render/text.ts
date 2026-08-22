/**
 * Text Renderer
 *
 * Renders text in SVG using fontkit path outlines for cross-browser identical rendering.
 */

import bidiFactory from "bidi-js";
import { computeSkipInkGaps, getDecorationMetrics, isStretchyFenceChar, measureEmphasisMarkMetrics, measureInkMetrics, renderStretchyFenceGlyph, renderTextAsPath } from "./text-to-path.js";
import type { FontVariantEmojiOverride } from "./font-resolution.js";
import type { FontSynthesisAllowance } from "./text-to-path.js";
import { r, esc } from "./format.js";
import { wrapPseudoPaintEffects } from "./pseudo-filter.js";
import type { CapturedElement, TextSegment } from "../capture/types.js";

// ── Rendering helpers ──

// MathML token elements whose border box Chromium sizes to its glyph ink
// (`math_token_layout_algorithm.cc`): the captured element rect top is the
// painted ink top, not the line-box top. The renderer positions these via the
// measured ink ascent (DM-832) instead of the font ascent. `<mo>` stretchy
// fences are handled earlier by `renderStretchyFenceGlyph` and never reach the
// ink-metric path.
const MATH_TOKEN_TAGS = new Set(["mo", "mi", "mn", "mtext", "ms"]);

/**
 * Emit `<line>` markup for each non-zero side border on a pseudo-element box.
 * Used for non-uniform pseudo borders (e.g. Slashdot's `.carouselHeading::after`
 * with a bare `border-bottom`) where the surrounding `<rect>` already painted
 * the box's fill/radius but its `stroke` shorthand can't represent a single-
 * side border. Returns "" when the box has no per-side borders.
 */
function renderPseudoBoxPerSideBorders(pb: NonNullable<TextSegment["pseudoBox"]>): string {
  const lines: string[] = [];
  // Stroke at the centre of the border-side, so half-width insets are
  // applied to the rect's edges to keep the stroke pixel-aligned with what
  // CSS paints (CSS paints borders inset to the box's outer edges, with the
  // stroke centre offset by half the border width from the rect edge).
  const x2 = pb.x + pb.width;
  const y2 = pb.y + pb.height;
  if (pb.borT != null && pb.borT > 0 && pb.borderTopColor != null) {
    const cy = pb.y + pb.borT / 2;
    lines.push(`<line x1="${r(pb.x)}" y1="${r(cy)}" x2="${r(x2)}" y2="${r(cy)}" stroke="${esc(pb.borderTopColor)}" stroke-width="${r(pb.borT)}"/>`);
  }
  if (pb.borR != null && pb.borR > 0 && pb.borderRightColor != null) {
    const cx = x2 - pb.borR / 2;
    lines.push(`<line x1="${r(cx)}" y1="${r(pb.y)}" x2="${r(cx)}" y2="${r(y2)}" stroke="${esc(pb.borderRightColor)}" stroke-width="${r(pb.borR)}"/>`);
  }
  if (pb.borB != null && pb.borB > 0 && pb.borderBottomColor != null) {
    const cy = y2 - pb.borB / 2;
    lines.push(`<line x1="${r(pb.x)}" y1="${r(cy)}" x2="${r(x2)}" y2="${r(cy)}" stroke="${esc(pb.borderBottomColor)}" stroke-width="${r(pb.borB)}"/>`);
  }
  if (pb.borL != null && pb.borL > 0 && pb.borderLeftColor != null) {
    const cx = pb.x + pb.borL / 2;
    lines.push(`<line x1="${r(cx)}" y1="${r(pb.y)}" x2="${r(cx)}" y2="${r(y2)}" stroke="${esc(pb.borderLeftColor)}" stroke-width="${r(pb.borL)}"/>`);
  }
  return lines.join("");
}

/**
 * Replace any UTF-16 code units flagged with `suppressGlyph` in the segment's
 * raster overlays with U+200B (zero-width space). The path renderer emits no
 * `<use>` for zero-contour glyphs, so this hides the underlying path glyph
 * while leaving the segment's xOffsets / aria-label / raster overlay intact.
 * Used for ::first-letter drop caps (DM-439) where the body-size path glyph
 * would otherwise show through behind the styled rasterized big letter.
 */
// DM-719: pull `-webkit-text-stroke-width / -color` + `paint-order` off the
// element styles into the trio of args `renderTextAsPath` expects. Returns
// `{ width: 0 }` when no stroke is set so the renderer keeps the unstroked
// fast path.
function textStrokeParams(styles: { webkitTextStrokeWidth?: string; webkitTextStrokeColor?: string; paintOrder?: string }): { width: number; color: string; paintOrder: string } {
  const widthCss = styles.webkitTextStrokeWidth;
  if (widthCss == null || widthCss === "" || widthCss === "0px" || widthCss === "0") {
    return { width: 0, color: "", paintOrder: "" };
  }
  const width = parseFloat(widthCss);
  if (!Number.isFinite(width) || width <= 0) {
    return { width: 0, color: "", paintOrder: "" };
  }
  return {
    width,
    color: styles.webkitTextStrokeColor ?? "currentColor",
    paintOrder: styles.paintOrder ?? "",
  };
}

// DM-920: text-emphasis-style → mark character mapping. Mirrors
// `ComputedStyle::TextEmphasisMarkString` in third_party/blink/renderer/
// core/style/computed_style.cc — the keyword form resolves to a single
// codepoint per (fill, shape) combination; the `<string>` form (e.g.
// `text-emphasis: "★"`) uses the literal string as the mark.
export function parseTextEmphasisMark(styleCss: string | undefined): string | null {
  if (styleCss == null || styleCss === "" || styleCss === "none") return null;
  // `<string>` form: `"★"` / `'·'`
  const stringMatch = /^["']([\s\S]+)["']$/.exec(styleCss.trim());
  if (stringMatch != null) return stringMatch[1];
  // Keyword form. Default fill is `filled` when only a shape is given.
  const isOpen = /\bopen\b/.test(styleCss);
  // Codepoint table from Chromium's character_names.h:
  if (/\bdot\b/.test(styleCss)) return isOpen ? "◦" : "•";
  if (/\bdouble-circle\b/.test(styleCss)) return isOpen ? "◎" : "◉";
  if (/\bcircle\b/.test(styleCss)) return isOpen ? "○" : "●";
  if (/\btriangle\b/.test(styleCss)) return isOpen ? "△" : "▲";
  if (/\bsesame\b/.test(styleCss)) return isOpen ? "﹆" : "﹅";
  return null;
}

const emphasisSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Blink iterates shaped clusters, then divides them by grapheme count. */
export function emphasisGraphemeSpans(text: string): Array<{ start: number; end: number; text: string }> {
  const parts = [...emphasisSegmenter.segment(text)];
  return parts.map((part, i) => ({
    start: part.index,
    end: parts[i + 1]?.index ?? text.length,
    text: part.segment,
  }));
}

function canReceiveTextEmphasis(grapheme: string): boolean {
  const first = [...grapheme][0] ?? "";
  return first !== "" && !/[\p{White_Space}\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(first);
}

// Blink `TextPainter::SetEmphasisMark` + `FillTextEmphasisGlyphsNG`:
// metric-derived line offset and one centered mark per grapheme.
export function renderTextEmphasisMarks(
  el: CapturedElement,
  fillColorFallback: string,
): string {
  const styleCss = el.styles.textEmphasisStyle;
  const mark = parseTextEmphasisMark(styleCss);
  if (mark == null) return "";
  if (el.textSegments == null) return "";
  const out: string[] = [];
  const position = el.styles.textEmphasisPosition ?? "over right";
  const isUnder = /\bunder\b/.test(position);
  const color = (el.styles.textEmphasisColor != null
    && el.styles.textEmphasisColor !== ""
    && el.styles.textEmphasisColor !== "currentcolor")
    ? el.styles.textEmphasisColor
    : (el.styles.color ?? fillColorFallback);
  for (const seg of el.textSegments) {
    if (seg.xOffsets == null || seg.text == null || seg.xOffsets.length === 0) continue;
    const segFs = seg.fontSize ?? (parseFloat(el.styles.fontSize) || 14);
    const segAscent = seg.fontAscent ?? el.fontAscent ?? segFs * 0.8;
    const segDescent = el.fontDescent ?? Math.max(0, segFs - segAscent);
    const baselineY = seg.y + segAscent;
    const segFontFamily = seg.fontFamily ?? el.styles.fontFamily;
    const segFontWeight = seg.fontWeight ?? el.styles.fontWeight;
    const segFontStyle = seg.fontStyle ?? el.styles.fontStyle;
    const metrics = measureEmphasisMarkMetrics(mark, {
      fontSize: segFs, fontFamily: segFontFamily, fontWeight: segFontWeight,
      fontStyle: segFontStyle, fontStretch: el.styles.fontStretch, lang: el.styles.lang,
    });
    if (metrics == null) continue;
    const offset = isUnder
      ? Math.ceil(segDescent + metrics.ascent)
      : Math.floor(-segAscent - metrics.descent);
    const markBaselineY = baselineY + offset;
    const spans = emphasisGraphemeSpans(seg.text);
    for (let n = 0; n < spans.length; n++) {
      const span = spans[n];
      if (!canReceiveTextEmphasis(span.text) || span.start >= seg.xOffsets.length) continue;
      const xStart = seg.xOffsets[span.start];
      const xEnd = (n + 1 < spans.length && spans[n + 1].start < seg.xOffsets.length)
        ? seg.xOffsets[spans[n + 1].start]
        : seg.x + seg.width;
      const xCenter = (xStart + xEnd) / 2;
      const styleAttr = segFontStyle != null && segFontStyle !== "normal"
        ? ` font-style="${esc(segFontStyle)}"` : "";
      out.push(`<text x="${r(xCenter - metrics.inkCenterX)}" y="${r(markBaselineY)}" font-family="${esc(segFontFamily)}" font-size="${r(metrics.fontSize)}" font-weight="${esc(String(segFontWeight))}"${styleAttr} fill="${esc(color)}">${esc(mark)}</text>`);
    }
  }
  return out.join("");
}

function suppressGlyphChars(text: string, seg: TextSegment | undefined): string {
  // DM-692: Chrome paints a visible hyphen at line-break points marked by
  // a soft-hyphen (U+00AD); SHYs not at the break paint nothing. Our
  // capture's per-char Range loop keeps EVERY SHY in the captured line
  // text (the height check at the line-break-pos doesn't zero them out),
  // so we have to disambiguate at render time: ONLY the trailing SHY of a
  // line is the visible hyphen — substitute with U+002D. Every other SHY
  // gets U+200B (zero-width space) so it preserves UTF-16 indexing for
  // xOffsets/rasterGlyphs but produces no glyph and no advance.
  const SHY = String.fromCharCode(0x00AD);
  const ZWSP = String.fromCharCode(0x200B);
  let normalized = text;
  if (text.indexOf(SHY) >= 0) {
    const lastNonWs = normalized.replace(/\s+$/, "").length - 1;
    let out = "";
    for (let i = 0; i < normalized.length; i++) {
      const ch = normalized[i];
      if (ch === SHY) out += (i === lastNonWs ? "-" : ZWSP);
      else out += ch;
    }
    normalized = out;
  }
  if (seg?.rasterGlyphs == null) return normalized;
  // DM-2410: a paint-bearing raster glyph is still part of the shaped source
  // run. Do not replace it with U+200B before font routing: that destroys the
  // selected glyph's advance and moves every following outline left. Skia's
  // macOS scaler makes the same split — a color typeface sets
  // `neverRequestPath`, but `generateMetrics` still reads the glyph advance
  // from CoreText (`SkScalerContext_mac_ct.cpp:297-311`, rev ebf5052). Our
  // path/embedded emitters likewise shape the original source, retain its
  // advance, and omit only the selected raster representation.
  //
  // Zero-area entries are different: they are structural suppression markers
  // for a separately captured ::first-letter segment and own no paint/advance
  // in this body run. Those keep the historical U+200B replacement.
  const suppress = seg.rasterGlyphs.filter((g) =>
    g.suppressGlyph === true && g.rect.width === 0 && g.rect.height === 0);
  const suppressedAt = new Set<number>();
  for (const glyph of suppress) {
    const fallbackLength = normalized.codePointAt(glyph.charIndex)! > 0xFFFF ? 2 : 1;
    const length = glyph.charLength ?? fallbackLength;
    for (let j = 0; j < length; j++) suppressedAt.add(glyph.charIndex + j);
  }
  if (suppress.length === 0) return normalized;
  // text is a UTF-16 string; charIndex is a UTF-16 position. U+200B is one
  // UTF-16 unit so the substitution preserves text length and xOffsets
  // alignment. DM-905: supplementary-plane codepoints (e.g. emoji like 😀
  // U+1F600) occupy TWO UTF-16 units (a surrogate pair). The capture's
  // charIndex points at the FIRST (high) surrogate; replacing only that
  // leaves the orphan low surrogate, which UTF-8 encodes as U+FFFD and
  // the embedded-font emit then paints as a replacement-character tofu.
  // When the suppressed char-at-i is a high surrogate, replace BOTH the
  // high and low surrogate with a single ZWSP and a second filler ZWSP
  // so xOffset / position indexing stays aligned 1:1.
  let out = "";
  for (let i = 0; i < normalized.length; i++) {
    const drop = suppressedAt.has(i);
    if (drop) {
      out += ZWSP;
    } else {
      out += normalized[i];
    }
  }
  return out;
}

/**
 * Emit <image> overlays for any per-char raster glyphs the capture layer
 * attached to this segment (SK-1090). These sit on top of the text-path
 * markup and cover the exact pixel region Chrome painted for the color-
 * bitmap codepoint (emoji, U+2713-family, etc.). Returns "" when the
 * segment has no raster glyphs or none of them have a resolved dataUri.
 */
export function rasterGlyphOverlays(seg: TextSegment, fallbackFontSize: number, clipId: string): string {
  if (seg.rasterGlyphs == null || seg.rasterGlyphs.length === 0) return "";
  const out: string[] = [];
  // Apple Color Emoji bitmaps are rendered by Chrome's CoreText at em-square
  // size (fontSize × fontSize), centered horizontally on the glyph advance and
  // baseline-aligned vertically. The captured `g.rect` is Chrome's per-char
  // bbox, which spans the FULL line-box height (~1.2-1.5em) and the advance
  // width (~1.05-1.1em) — bigger than the painted bitmap on both axes. The
  // earlier `xMidYMid meet` strategy fitted a square bitmap into the rect
  // using `min(rect.w, rect.h)` as the side length, which over-shot Chrome's
  // em-square paint by ~1px and shifted the bitmap down by ~1px relative to
  // the baseline — producing the colored fringe DM-381 reported. Emit at
  // em-square size centered in the rect instead. (DM-381)
  for (const g of seg.rasterGlyphs) {
    if (g.dataUri == null) continue;
    // Emit the screenshot at exactly the captured rect coords + dims. The
    // PNG was screenshot from Chrome's actual paint at this rect, so
    // re-embedding it at the same rect preserves the painted geometry
    // pixel-for-pixel. Earlier (DM-381) we stretched to em-square via
    // `width=fontSize height=fontSize preserveAspectRatio=none`, which
    // squished tall line-box rects horizontally — flag emoji and other
    // raster glyphs rendered visibly larger than Chrome's actual paint
    // (DM-401 / DM-411 / DM-414).
    // DM-823: floated `::first-letter` drop caps (`float: left; font-size: Nem;
    // initial-letter: N M`) paint OUTSIDE their parent paragraph's box —
    // Chrome's float layout naturally extends the W / B / T above and to the
    // left of the `<p>` border-box. Capture marks these per-char rasters with
    // `suppressGlyph: true` so the underlying path glyph isn't double-emitted
    // (DM-439). Use that same flag here as a signal to OMIT the parent's
    // overflow-clip on the raster `<image>`: the parent's clip rect is the
    // `<p>`'s own bounds, which clips off the top portion of the drop cap
    // exactly where the float overflows. For non-drop-cap raster glyphs
    // (emoji in the middle of text) the parent clip is still desirable.
    const skipClip = g.suppressGlyph === true;
    const clipAttr = skipClip ? "" : ` clip-path="url(#${clipId})"`;
    out.push(`<image href="${g.dataUri}" x="${r(g.rect.x)}" y="${r(g.rect.y)}" width="${r(g.rect.width)}" height="${r(g.rect.height)}" preserveAspectRatio="none"${clipAttr}/>`);
  }
  return out.join("");
}

/**
 * Emit SVG lines for CSS text-decoration-line (underline / line-through /
 * overline). Each segment gets its own line anchored to the segment's box —
 * this matches how browsers paint decoration on each inline box instead of
 * one continuous line across gaps. Returns "" when no decoration applies.
 *
 * Geometry is Blink's, transcribed (Chromium rev 7d859f27): offsets anchor on
 * the text FRAGMENT TOP via the captured FloatAscent (`getDecorationMetrics`),
 * and the paint-time y-snap (`decoration_line_painter.cc` SnapYAxis /
 * RoundDownThickness) is applied per line at emit. Only `from-font` and
 * `text-underline-position: under` consult font tables (post underline
 * metrics, OS/2 typo metrics); the auto rules are font-size / ascent driven.
 * Gated by `npm run decorations:oracle` (rule-vs-SVG leg), NOT by pixel-diff.
 */
/** Args for {@link renderTextDecoration} — an options object so the 15 fields
 *  can't be transposed at the (two) call sites. */
interface TextDecorationOptions {
  textDecorationLine: string | undefined;
  decorationColor: string;
  style: string | undefined;
  segX: number;
  /** Text fragment top (line-over edge) of the DECORATING box's line, in
   *  viewport px. Blink anchors every decoration offset here
   *  (`local_origin_.line_over` in `core/paint/text_decoration_info.cc`); for
   *  a propagated decoration this is the ancestor's line, reconstructed as
   *  its picked baseline minus its captured FloatAscent. */
  fragTop: number;
  /** FloatAscent of the METRICS font (the decorating box's — captured
   *  `fontAscent`). Undefined falls back to `0.8 × fontSize`. */
  fontAscent?: number;
  /** FloatDescent of the metrics font — only feeds the `under`-position
   *  normalized-typo-descent fallback. */
  fontDescent?: number;
  /** TRUE (unrounded) baseline of the RUN's painted glyphs, viewport px —
   *  the y the skip-ink intercept band is expressed against, since glyph
   *  outlines are shaped baseline-relative. For a propagated decoration this
   *  stays the run's own baseline (the ink IS the run's glyphs). */
  runBaselineY: number;
  segWidth: number;
  fontSize: number;
  fontFamily: string;
  fontWeight: string | number;
  fontStyle: string | undefined;
  /** Computed CSS `font-stretch` (a percentage string). The decoration
   *  metrics and skip-ink intercepts must resolve the same cut / axis
   *  instance the glyphs came from, or a condensed run is underlined where
   *  the normal cut wants it. */
  fontStretch?: string;
  /** CSS `text-decoration-thickness` (e.g. `5px` or `auto`). DM-431. */
  thicknessOverride?: string;
  /** CSS `text-underline-offset` (e.g. `6px` or `auto`). DM-431. */
  underlineOffset?: string;
  /** CSS `text-underline-position` (`auto` / `from-font` / `under` / `left` /
   *  `right`). DM-1819: horizontal text ignored this entirely, so `under` drew
   *  through the descenders. */
  underlinePosition?: string;
  /** Run text used to compute `text-decoration-skip-ink: auto` glyph
   *  intercepts. Required for skip-ink to apply. DM-446. */
  runText?: string;
  /** CSS `text-decoration-skip-ink` — `auto` (default) or `none`. Only solid /
   *  double underlines honor it (matches Chromium). DM-446. */
  skipInk?: string;
  /** OpenType feature tags forwarded to fontkit shaping when computing skip-
   *  ink intercepts so small-caps / petite-caps glyphs match the painted text. */
  features?: string[];
  /** Chromium-captured per-char x offsets, run-relative (xOffsets[i] - segX),
   *  used to anchor skip-ink intercepts at the painted positions (DM-1698). */
  runXOffsets?: number[];
  /** DM-1723: decoration-metrics font overrides for PROPAGATED decorations.
   *  Blink positions a decoration and derives its auto thickness from the
   *  DECORATING box's used font (`text_decoration_info.cc`:
   *  `decoration.used_font = decorating_box->GetUsedFont()`), not the
   *  decorated text's own font. When a descendant paints an ancestor's
   *  propagated decoration, these carry the ancestor's font so the line
   *  lands at the same y/thickness as the ancestor's own runs. Skip-ink
   *  intercepts still shape with the run's own font (the ink IS the run's
   *  glyphs). Default to the run's font when absent. */
  metricsFontFamily?: string;
  metricsFontSize?: number;
  metricsFontWeight?: string | number;
  metricsFontStyle?: string;
  /** Unique id base for the `<clipPath>`s the patterned decoration styles
   *  emit — unique per `renderTextDecoration` call (the per-line-kind suffix
   *  is appended inside `emitDecorationLine`). */
  idBase?: string;
}

export interface DecorationLineCtx {
  /** CSS text-decoration-style. */
  style: string | undefined;
  /** True (unrounded) baseline of the run's glyphs — skip-ink band anchor. */
  runBaselineY: number;
  /** Physical painted-fragment line origin. Blink places the wavy tile here;
   *  its internal -wavelength phase is zero modulo one wavelength. */
  segX: number;
  decorationColor: string;
  /** Skip-ink gap intervals for an intercept band centered `yRel` below the
   *  run baseline, `thick` px tall, each intercept dilated `pad` px per side
   *  (Blink's `min(LINE thickness, 13)` — the band height and the dilation
   *  are DIFFERENT inputs whenever the band is taller than the line). */
  computeGapsAt: (yRel: number, thick: number, pad: number) => Array<[number, number]>;
  subSegments: (gaps: Array<[number, number]>) => Array<{ x0: number; x1: number }>;
  /** Unique id base for the `<clipPath>` a patterned (dashed / dotted / wavy)
   *  full-span decoration emits when skip-ink gaps (or the wavy pattern-rect
   *  crop) remove ink from it. Callers must make it unique per
   *  `emitDecorationLine` invocation up to the line kind, which is suffixed
   *  here. Absent (unit tests) falls back to a non-unique `"deco"`. */
  clipIdBase?: string;
}

/**
 * Emit one decoration line honoring text-decoration-style (extracted from
 * `renderTextDecoration`, DM-1458). `yTop` is the decoration rect's TOP in
 * viewport px, UNSNAPPED — `fragTop + getDecorationMetrics().<line>Top` — and
 * `t` the resolved (unsnapped) thickness. The paint-time snap is applied here
 * per style, transcribed from `core/paint/decoration_line_painter.cc`
 * (Chromium rev 7d859f27):
 *
 *   solid/double  SnapYAxis: top → floor(top + 0.5), height →
 *                 max(floor(t), 1)  (`:21-23,40-45,104-124`); the double's
 *                 second bar offsets by ±(t+1) / floor(t+1) from the first
 *                 (`text_decoration_info.cc:259-284`) and snaps independently
 *                 (`:462-472` — each `DrawLineAsRect` call snaps its own rect)
 *   dashed/dotted GetSnappedPointsForTextLine: midY = floor(top + max(t/2,
 *                 0.5)), plus 0.5 when roundf(t) is odd; stroke width stays
 *                 the unsnapped t  (`:47-53,55-76`)
 *   wavy          no snap; the stroked cubic's centerline sits at
 *                 top + wavy_offset + 0.5  (`WavyGeometry::PathOrigin` +
 *                 `PaintRibbon`, `:298-304,325-349`)
 *
 * `line` picks the second-bar / wavy offset sign; `skipsInk` says whether
 * THIS line participates in `text-decoration-skip-ink`. Underline and
 * overline do; line-through never does, and that is upstream's explicit
 * choice rather than an omission — `PaintLineThroughDecorations` carries the
 * comment "No skip: ink for line-through" and cites
 * https://github.com/w3c/csswg-drafts/issues/711
 * (`core/paint/text_decoration_painter.cc:214-247`).
 * Gaps come via the `ctx` closures, which stay bound to the run's geometry;
 * the intercept band is `DecorationLinePainter::Bounds` per style — the
 * UNSNAPPED rect for solid, that rect extended over both bars for double,
 * the snapped rounded-thickness midline band for dashed/dotted, and the
 * floor/ceil'd stroke bounding rect of the wave for wavy
 * (`decoration_line_painter.cc:409-436`) — with the 0.5px inset applied
 * inside `computeSkipInkGaps` (`text_painter.cc:589-590`).
 *
 * Emission mirrors Blink's CLIP mechanism (`TextPainter::ClipDecorationLine`
 * clips OUT one dilated rect per glyph intercept, then `PaintDecorationLine`
 * strokes the FULL span through the clip): solid/double split into
 * sub-segment `<line>`s — exactly equivalent for an unpatterned horizontal
 * line — while dashed/dotted/wavy emit ONE full-span element plus a
 * `<clipPath>` of the surviving sub-segment rects, so the dash pattern and
 * wave phase are computed once across the whole run and gaps merely remove
 * ink from them. Exported for unit testing (not in the package barrel).
 */
export function emitDecorationLine(
  yTop: number, t: number, line: "underline" | "overline" | "line-through",
  skipsInk: boolean, ctx: DecorationLineCtx,
): string {
  const { style, runBaselineY, segX, decorationColor, computeGapsAt, subSegments, clipIdBase } = ctx;
  const clipId = `${clipIdBase ?? "deco"}-${line === "underline" ? "u" : line === "overline" ? "o" : "t"}`;
  // Horizontal dilation of each skip-ink intercept: `min(LINE thickness, 13)`
  // (`kDecorationClipMaxDilation`, `text_painter.cc:46,607-608`). Blink reads
  // `geometry.Thickness()` — the line's own thickness — for EVERY style, so
  // the tall wavy / double intercept bands do not inflate the dilation.
  const pad = Math.min(t, 13);
  // Second-bar / wavy offset from the first bar's top —
  // `text_decoration_info.cc:259-284`: +(t+1) below for underline, −(t+1)
  // above for overline, floor(t+1) for line-through (floored so the double
  // gap doesn't change size with the downstream snap; wavy uses 0 there).
  const doubleOffset = line === "underline" ? t + 1 : line === "overline" ? -(t + 1) : Math.floor(t + 1);
  // `RoundDownThickness` — the snapped bar height for solid / double.
  const hSnap = Math.max(Math.floor(t), 1);
  if (style === "wavy") {
    // Decoration phase is a paint-coordinate invariant. Preserve capture's
    // sub-tenth-pixel fragment origin (not the renderer-wide 0.1px formatter),
    // especially after zoom/transforms where a 0.05px phase error is visible.
    const wr = (n: number) => Number(n.toFixed(3)).toString();
    // Match Chromium's `decoration_line_painter.cc::MakeWave` + `WavyPath`:
    //   wavelength = 1 + 2 * round(2 * thickness + 0.5)
    //   cp_distance = 0.5 + round(3 * thickness + 0.5)
    // Each wavelength is one cubic Bezier with both control points at
    // `wavelength/2` x — `cp1.y = +cp_distance`, `cp2.y = -cp_distance` —
    // producing an S-curve from `(0, 0)` through a peak / trough back to
    // `(wavelength, 0)`. Blink strokes this centerline at the resolved
    // thickness; the visual amplitude is implicit in the curve (measured
    // ≈ 0.278 × cp_distance — used below only to size the skip-ink band).
    //
    // Earlier we rendered as quadratic Q curves with the control point at
    // `±cp_distance` directly; that paints visual amplitude `cp_distance/2`
    // — about 70% taller than Chrome — making 18 px wavy underlines look
    // exaggerated. Cubic reproduces Chrome's geometry. (DM-446.)
    // `MakeWave` clamps the thickness feeding the wave DEFINITION to ≥ 1
    // (`decoration_line_painter.cc:181-193`); the stroke width and the
    // stroke-bounds thickness stay the unclamped resolved value.
    const tWave = Math.max(1, t);
    const wavelength = 1 + 2 * Math.round(2 * tWave + 0.5);
    const cpDist = 0.5 + Math.round(3 * tWave + 0.5);
    // Placement, transcribed: the wavy ribbon's CENTERLINE sits at the line
    // rect's top + wavy_offset + 0.5. For HTML text the wave is painted as a
    // repeating tile (`PaintWavyTextDecoration`, non-SVG branch): the tile
    // record draws `WavyPath` — whose centerline `WavyCenterlinePath` starts
    // at y=0.5 by default — translated by `-bounds_.y()`, and the tile is
    // placed at `PaintRect(geometry)`, whose origin is
    // `line.origin + bounds_.OffsetFromOrigin + (0, wavy_offset)`
    // (`decoration_line_painter.cc:288-296,330-345,477-533`). The bounds
    // translation cancels, so the centerline lands at
    // `line.y + wavy_offset + 0.5`. The wavy offset is the same ±(t+1) / 0
    // family as the double offset (`text_decoration_info.cc:259-284`).
    const wavyOffset = line === "line-through" ? 0 : doubleOffset;
    const yWave = yTop + wavyOffset + 0.5;
    // The wavy pattern rect (`ComputeWavyPatternRect`,
    // `decoration_line_painter.cc:200-212`): Blink takes the STROKE BOUNDING
    // RECT of the cubic centerline at stroke width t —
    // `Path::StrokeBoundingRect` is the tight bounds of the Skia-stroked
    // outline (`getFillPath(...).computeTightBounds()`,
    // `platform/geometry/path.cc:161-166`, fetched at rev 7d859f27), NOT the
    // control-point bounds — then floors the top and ceils the bottom.
    // Analytically: the cubic with y controls (0, +cpDist, −cpDist, 0)
    // reaches ±cpDist/(2√3) (extremum of 3s(1−s)(1−2s) at s=(3−√3)/6), and
    // the stroke offsets that by t/2; the centerline sits at path-local
    // y=0.5. This replaces the empirical `0.278 × cpDist` visual-amplitude
    // band (0.278 was a probe-fitted approximation of 1/(2√3) ≈ 0.28868, and
    // the old band ignored the floor/ceil snap entirely).
    const amp = cpDist / (2 * Math.sqrt(3));
    const bandTopRel = Math.floor(0.5 - (amp + t / 2));
    const bandBottomRel = Math.ceil(0.5 + amp + t / 2);
    const bandTop = yTop + wavyOffset + bandTopRel;
    const bandH = bandBottomRel - bandTopRel;
    // Skip-ink gaps against the pattern-rect band; the intercept dilation
    // stays the LINE thickness (`min(t, 13)`), not the band height.
    const wavyGaps = skipsInk ? computeGapsAt(bandTop + bandH / 2 - runBaselineY, bandH, pad) : [];
    const subs = subSegments(wavyGaps);
    if (subs.length === 0) return "";
    // ONE continuous wave, phase 0 at the physical fragment line origin. The
    // tile shader anchors at `PaintRect.x = line.x`; MakeWave's exact
    // `-wavelength` phase folds to zero modulo λ. It is clipped to the
    // pattern rect's vertical extent. This is Chrome's mechanism verbatim:
    // the tile crop bounds the wave to the pattern rect, and
    // `TextPainter::ClipDecorationLine` clips OUT each dilated intercept
    // (`text_painter.cc:574-628`) — so the wave keeps one phase across gaps
    // and gap edges cut vertically instead of following the stroke's tangent
    // (which the previous per-sub-segment de Casteljau extraction did).
    const kEnd = Math.ceil((Math.max(...subs.map((s) => s.x1)) - segX) / wavelength);
    let d = `M ${wr(segX)} ${wr(yWave)}`;
    for (let k = 0; k < kEnd; k++) {
      const gx = segX + k * wavelength;
      d += ` C ${wr(gx + wavelength / 2)} ${wr(yWave + cpDist)} ${wr(gx + wavelength / 2)} ${wr(yWave - cpDist)} ${wr(gx + wavelength)} ${wr(yWave)}`;
    }
    const rects = subs.map(({ x0, x1 }) =>
      `<rect x="${wr(x0)}" y="${wr(bandTop)}" width="${wr(x1 - x0)}" height="${wr(bandH)}"/>`).join("");
    return `<clipPath id="${clipId}">${rects}</clipPath>`
      + `<path d="${d}" fill="none" stroke="${decorationColor}" stroke-width="${wr(t)}" clip-path="url(#${clipId})"/>`;
  }
  if (style === "double") {
    // Double: two parallel bars. The second bar sits `doubleOffset` from the
    // first (+(t+1) below for underline, −(t+1) above for overline,
    // floor(t+1) for line-through — `text_decoration_info.cc:259-284`), and
    // EACH bar snaps its own rect through SnapYAxis, exactly as Blink's two
    // `DrawLineAsRect` calls do (`decoration_line_painter.cc:462-472`).
    const top1 = Math.floor(yTop + 0.5);
    const top2 = Math.floor(yTop + doubleOffset + 0.5);
    // Skip-ink band = `DecorationLinePainter::Bounds` for kDoubleStroke: the
    // UNSNAPPED first rect extended to cover the offset bar —
    // top = min(y, y + doubleOffset), height = t + |doubleOffset|
    // (`decoration_line_painter.cc:423-431`); `computeSkipInkGaps` applies
    // the 0.5px inset (`text_painter.cc:589-590`).
    const bandTop = Math.min(yTop, yTop + doubleOffset);
    const bandThickness = t + Math.abs(doubleOffset);
    const dblGaps = skipsInk
      ? computeGapsAt(bandTop + bandThickness / 2 - runBaselineY, bandThickness, pad)
      : [];
    const subs = subSegments(dblGaps);
    const yA = top1 + hSnap / 2;
    const yB = top2 + hSnap / 2;
    return subs.map(({ x0, x1 }) =>
      `<line x1="${r(x0)}" y1="${r(yA)}" x2="${r(x1)}" y2="${r(yA)}" stroke="${decorationColor}" stroke-width="${r(hSnap)}"/>`
      + `<line x1="${r(x0)}" y1="${r(yB)}" x2="${r(x1)}" y2="${r(yB)}" stroke="${decorationColor}" stroke-width="${r(hSnap)}"/>`
    ).join("");
  }
  if (style === "dashed" || style === "dotted") {
    // Dashed / dotted use Chromium's real dash geometry (see
    // decorationDashPattern) instead of the old fixed `2t 2t` / `t t`
    // dasharrays, which painted visibly shorter, denser dashes than Chrome.
    //
    // Y placement is `GetSnappedPointsForTextLine` — midY = floor(top +
    // max(t/2, 0.5)) — plus the odd-integer-thickness half-pixel shift of
    // `DrawLineAsStroke` (`decoration_line_painter.cc:47-53,71-76`); the
    // stroke width stays the UNSNAPPED t (only the dash intervals round).
    const ti = Math.round(t);
    const yMidSnap = Math.floor(yTop + Math.max(t / 2, 0.5));
    const yMid = yMidSnap + (ti % 2 !== 0 ? 0.5 : 0);
    // The endpoints TRUNCATE to integers: `GetSnappedPointsForTextLine`
    // returns `gfx::Point` — an int-coordinate point, so the float rect's
    // `x()` / `right()` convert by C++ float→int truncation — and
    // `DrawLineAsStroke` computes the dash-fit `path_length` over that
    // integer span BEFORE the thick-dotted endpoint inset
    // (`decoration_line_painter.cc:47-53,55-76`, `ui/gfx/geometry/point.h:30`).
    const [span] = subSegments([]);
    if (span == null) return "";
    const ix0 = Math.trunc(span.x0);
    const ix1 = Math.trunc(span.x1);
    // Blink does not gate skip-ink on the line style — `ClipDecorationLine`
    // reads only `TextDecorationSkipInk()`, never the style — so dashed and
    // dotted skip ink exactly as solid does. The intercept band is
    // `DecorationLinePainter::Bounds` for kDashed/kDottedStroke: the SNAPPED
    // midline band of height roundf(t) (`decoration_line_painter.cc:409-417`
    // — `start.y() − thickness/2` with the rounded thickness), while the
    // dilation stays the unrounded `min(t, 13)`.
    //
    // The dash pattern is computed ONCE over the full integer span and the
    // gaps merely remove ink from it via the clip — so the phase is
    // continuous across every gap. (This used to split the run into one
    // `<line>` per surviving sub-segment, and `decorationDashPattern`
    // re-fitted the gap per segment: a single `stroke-dasharray="6 4.2"`
    // line became three reading `6 3.6`, `6 2.8`, `6 3.9`, restarting the
    // phase at each gap — which is why dashed/dotted were excluded from
    // skip-ink until the emit switched to one line plus a clip path.)
    const gaps = skipsInk ? computeGapsAt(yMidSnap - runBaselineY, ti, pad) : [];
    const subs = subSegments(gaps);
    if (subs.length === 0) return "";
    const pat = decorationDashPattern(style, t, ix1 - ix0);
    const lineMarkup = `<line x1="${r(ix0 + pat.inset)}" y1="${r(yMid)}" x2="${r(ix1 - pat.inset)}" y2="${r(yMid)}" stroke="${decorationColor}" stroke-width="${r(t)}"${pat.attrs}/>`;
    if (gaps.length === 0 || (subs.length === 1 && subs[0].x0 === span.x0 && subs[0].x1 === span.x1)) {
      return lineMarkup;
    }
    // Clip rects = the complement of the gap intervals, spanning the painted
    // stroke vertically with Blink's ±1px vertical clip-rect outset
    // (`clip_rect.Outset(OutsetsF::VH(1.0, dilation))`,
    // `text_painter.cc:607-618`). The vertical extent is free as long as it
    // covers the stroke — Blink's clip-out rects always cover the painted
    // ink vertically (up to a sub-0.5px sliver when an odd rounded thickness
    // shifts a thin stroke half a pixel past the band edge, which is below
    // AA resolution) — so keeping ONLY inside these rects equals Blink's
    // clip-OUT of the gap rects.
    const clipRects = subs.map(({ x0, x1 }) =>
      `<rect x="${r(x0)}" y="${r(yMid - t / 2 - 1)}" width="${r(x1 - x0)}" height="${r(t + 2)}"/>`).join("");
    return `<clipPath id="${clipId}">${clipRects}</clipPath>`
      + `<g clip-path="url(#${clipId})">${lineMarkup}</g>`;
  }
  // Solid: the split-into-sub-segments emit below is EXACTLY Blink's
  // clip-mechanism result for a solid line — the clip-out rects cut a
  // horizontal rect at vertical edges, which is what ending one `<line>` and
  // starting the next reproduces (butt caps are vertical) — so no clip path
  // is needed. Intercept band = the UNSNAPPED rect
  // (`DecorationLinePainter::Bounds` for kSolidStroke returns
  // `geometry.line` before any snap).
  const solidGaps = skipsInk ? computeGapsAt(yTop + t / 2 - runBaselineY, t, pad) : [];
  const subs = subSegments(solidGaps);
  // SnapYAxis — rect top floor(y + 0.5), height max(floor(t), 1) —
  // emitted as a centered stroke so the painted rect is exactly the snapped
  // one (`decoration_line_painter.cc:40-45,104-124`).
  const yTopSnapped = Math.floor(yTop + 0.5);
  const yLine = yTopSnapped + hSnap / 2;
  return subs.map(({ x0, x1 }) =>
    `<line x1="${r(x0)}" y1="${r(yLine)}" x2="${r(x1)}" y2="${r(yLine)}" stroke="${decorationColor}" stroke-width="${r(hSnap)}"/>`
  ).join("");
}

/**
 * DM-1724: Chromium's dashed / dotted decoration-line dash geometry, ported
 * from `styled_stroke_data.cc` (`DashEffectFromStrokeStyle` +
 * `SelectBestDashGap`) and `decoration_line_painter.cc` (`DrawLineAsStroke`).
 * The old fixed `stroke-dasharray="2t 2t"` (dashed) / `"t t"` (dotted)
 * painted ~10-11 short dashes where Chrome paints ~8 longer ones:
 *
 * - Dash geometry is driven by the ROUNDED integer thickness
 *   (`DrawLineAsStroke`: `dash_thickness = roundf(thickness)`; falls back to
 *   the float thickness when it rounds to 0), while the painted stroke width
 *   stays the unrounded value.
 * - Dashed: dash = ti×(ti≥3 ? 2 : 3), gap = ti×(ti≥3 ? 1 : 2) — thin lines
 *   get LONGER dashes so they don't read as dots — then the gap is re-fitted
 *   (`SelectBestDashGap`) so a whole number of dashes spans the run, choosing
 *   the dash count whose fitted gap deviates least from the ideal.
 * - A run too short for 2 dashes paints SOLID; a run shorter than
 *   2·dash + gap paints exactly two proportionally-scaled dashes.
 * - Dotted with ti ≤ 3 (`StrokeIsDashed`): square dots, intervals {ti, ti},
 *   no gap fitting. Dotted with ti > 3: ROUND dots — zero-length dashes with
 *   round caps, gap fitted, pattern `0 (gap + ti − ε)` — and the endpoints
 *   move IN by ti/2 (`inset`) because the round caps extend past them. The
 *   dash intervals are computed from the UN-inset length (Blink computes
 *   `path_length` before the inset).
 * - Dash phase 0 — the pattern starts at the run's left edge (MakeDash offset
 *   0), which per-fragment emit already provides.
 *
 * Returns SVG attrs to append to the `<line>` plus the per-end `inset`.
 * Exported for unit testing (not in the package barrel).
 */
export function decorationDashPattern(style: "dashed" | "dotted", thickness: number, length: number): { attrs: string; inset: number } {
  const ti = Math.round(thickness) || thickness;   // dash geometry basis
  // `SelectBestDashGap` (open path): pick the dash count whose fitted gap is
  // closest to the ideal gap; a two-dash minimum keeps `minNumGaps ≥ 1`.
  const selectBestDashGap = (strokeLength: number, dashLength: number, gapLength: number): number => {
    const available = strokeLength + gapLength;
    const minNumDashes = Math.floor(available / (dashLength + gapLength));
    const maxNumDashes = minNumDashes + 1;
    const minGap = (strokeLength - minNumDashes * dashLength) / (minNumDashes - 1);
    const maxGap = (strokeLength - maxNumDashes * dashLength) / (maxNumDashes - 1);
    return (maxGap <= 0) || (Math.abs(minGap - gapLength) < Math.abs(maxGap - gapLength)) ? minGap : maxGap;
  };
  const dashed = style === "dashed";
  if (dashed || ti <= 3) {
    // `StrokeIsDashed`: dashed at any thickness, dotted only when thin.
    let dashLen = ti;
    let gapLen = ti;
    if (dashed) {
      dashLen *= ti >= 3 ? 2 : 3;
      gapLen *= ti >= 3 ? 1 : 2;
    }
    if (length <= dashLen * 2) return { attrs: "", inset: 0 };   // no space for dashes → solid
    const twoDashesWithGap = 2 * dashLen + gapLen;
    if (length <= twoDashesWithGap) {
      const m = length / twoDashesWithGap;
      return { attrs: ` stroke-dasharray="${r(dashLen * m)} ${r(gapLen * m)}"`, inset: 0 };
    }
    const gap = dashed ? selectBestDashGap(length, dashLen, gapLen) : gapLen;
    return { attrs: ` stroke-dasharray="${r(dashLen)} ${r(gap)}"`, inset: 0 };
  }
  // Thick dotted: round dots (zero-length round-cap dashes), endpoint inset.
  const perDot = ti * 2;
  if (length < perDot) {
    return { attrs: ` stroke-dasharray="0 ${r(perDot)}" stroke-linecap="round"`, inset: ti / 2 };
  }
  const gap = selectBestDashGap(length, ti, ti);
  return { attrs: ` stroke-dasharray="0 ${r(gap + ti - 0.01)}" stroke-linecap="round"`, inset: ti / 2 };
}

function renderTextDecoration(opts: TextDecorationOptions): string {
  const {
    textDecorationLine, decorationColor, style, segX, fragTop, runBaselineY, segWidth,
    fontSize, fontFamily, fontWeight, fontStyle, fontStretch, thicknessOverride,
    underlineOffset, underlinePosition, runText, skipInk, features, runXOffsets,
  } = opts;
  if (textDecorationLine == null || textDecorationLine === "none" || textDecorationLine === "") return "";
  // DM-1723: decoration metrics (position, auto thickness) come from the
  // decorating box's font — which differs from the run's own font when this
  // run paints an ancestor's propagated decoration. Skip-ink below keeps
  // using the run's own font. See `TextDecorationOptions.metricsFontFamily`.
  const mFontFamily = opts.metricsFontFamily ?? fontFamily;
  const mFontSize = opts.metricsFontSize ?? fontSize;
  const mFontWeight = opts.metricsFontWeight ?? fontWeight;
  const mFontStyle = opts.metricsFontStyle ?? fontStyle;
  const m = getDecorationMetrics(
    { fontFamily: mFontFamily, fontSize: mFontSize, fontWeight: mFontWeight, fontStyle: mFontStyle, fontStretch },
    { thicknessOverride, underlineOffsetCss: underlineOffset, underlinePositionCss: underlinePosition,
      fontAscent: opts.fontAscent, fontDescent: opts.fontDescent });
  const lines: string[] = [];
  const has = (k: string) => textDecorationLine.includes(k);
  // Skip-ink is style-AGNOSTIC in Blink. `TextDecorationPainter` calls
  // `ClipDecorationLine` for underline and overline alike, reading only
  // `TextDecorationSkipInk()` and never the line style
  // (`core/paint/text_decoration_painter.cc:180-207`, Chromium rev 7d859f27) —
  // so dashed and dotted skip ink too. The single exemption is the
  // spelling/grammar marker, which `continue`s before reaching the clip.
  //
  // This previously short-circuited dashed / dotted and cited
  // `decoration_line_painter.cc::Paint`, which contains no skip-ink logic at
  // all; the gating and the citation were both wrong.
  const skipInkActive = (skipInk == null || skipInk === "auto") && runText != null && runText !== "";
  // Compute X-range gaps where the underline rect crosses glyph ink. Returned
  // gaps are run-relative (0 = segX); subSegments() splits the underline span
  // around them.
  function computeGapsAt(yRel: number, thick: number, pad: number): Array<[number, number]> {
    if (!skipInkActive || runText == null) return [];
    return computeSkipInkGaps(runText, { fontSize, fontFamily, fontWeight, fontStyle, fontStretch, features },
      { decorationCenterYRel: yRel, decorationThickness: thick, interceptPad: pad, targetWidth: segWidth, charXOffsets: runXOffsets });
  }
  // Split [segX, segX+segWidth] into sub-runs by removing gap intervals
  // (run-relative; gap[0]+segX is absolute screen X).
  function subSegments(gaps: Array<[number, number]>): Array<{ x0: number; x1: number }> {
    const x0 = segX;
    const x1 = segX + segWidth;
    if (gaps.length === 0) return [{ x0, x1 }];
    const out: Array<{ x0: number; x1: number }> = [];
    let cursor = x0;
    for (const [ga, gb] of gaps) {
      const ax = segX + ga;
      const bx = segX + gb;
      if (bx <= cursor) continue;
      if (ax > cursor) out.push({ x0: cursor, x1: Math.min(ax, x1) });
      cursor = Math.max(cursor, bx);
      if (cursor >= x1) break;
    }
    if (cursor < x1) out.push({ x0: cursor, x1 });
    return out.filter((r) => r.x1 - r.x0 > 0.25);
  }
  // Emit one decoration line per applied line kind. `fragTop + m.<line>Top`
  // is the UNSNAPPED rect top in viewport px; `emitDecorationLine` applies
  // the per-style paint snap (see its doc).
  const decorationLineCtx: DecorationLineCtx = {
    style, runBaselineY, segX, decorationColor, computeGapsAt, subSegments,
    clipIdBase: opts.idBase,
  };
  if (has("underline")) {
    lines.push(emitDecorationLine(fragTop + m.underlineTop, m.thickness, "underline", true, decorationLineCtx));
  }
  if (has("line-through")) {
    lines.push(emitDecorationLine(fragTop + m.lineThroughTop, m.thickness, "line-through", false, decorationLineCtx));
  }
  if (has("overline")) {
    // Overline skips ink in Blink exactly as underline does — the same
    // `ClipDecorationLine` call with the same `skip_ink` value.
    lines.push(emitDecorationLine(fragTop + m.overlineTop, m.thickness, "overline", true, decorationLineCtx));
  }
  return lines.join("");
}

/** Geometry + run context shared by every applied decoration of one run. */
interface AppliedDecorationRunCtx {
  segX: number;
  /** The run's text fragment top (captured `textTop` / segment y), viewport px. */
  fragTop: number;
  /** Captured Chrome FloatAscent of the run's font (`fontAscent`); undefined
   *  falls back to `0.8 × fontSize`. */
  fontAscent?: number;
  /** Captured FloatDescent — feeds only the `under`-position NTD fallback. */
  fontDescent?: number;
  segWidth: number;
  fontSize: number;
  fontFamily: string;
  fontWeight: string | number;
  runText?: string;
  features?: string[];
  runXOffsets?: number[];
  /** Unique id base for this run's decoration `<clipPath>`s — unique per
   *  run/fragment (per-decoration and per-line-kind suffixes are appended
   *  downstream). */
  idBase?: string;
}

/**
 * DM-1723/DM-1725: emit every decoration that applies to one text run —
 * mirroring Blink's `ComputedStyle::AppliedTextDecorations` accumulation.
 * Ancestor decorating boxes' propagated entries (outermost-first, from the
 * `propagateTextDecorations` pre-pass) each paint independently with their
 * own line/style/color/thickness and with the DECORATING box's font as the
 * metrics basis (`text_decoration_info.cc`: `decoration.used_font =
 * decorating_box->GetUsedFont()`); the element's own decoration (from its
 * computed styles, with the run's own font as metrics basis) paints last —
 * innermost, matching applied order. `currentcolor` resolves against the
 * decorating element's color for propagated entries (resolved at pre-pass
 * time) and against `fallbackColor` (the run's fill) for the element's own.
 * Skip-ink intercepts always shape with the run's own font — the ink IS the
 * run's glyphs.
 */
/**
 * DM-1732: the baseline a PROPAGATED decoration paints at. Blink positions an
 * inherited decoration at the DECORATING box's line, not the decorated text's
 * own baseline (`text_decoration_info.cc` `offset_from_decorating_box`) — so
 * `<u>x<sub>2</sub></u>` paints ONE continuous underline at the parent's
 * position instead of a stepped one under the sub. The propagated entry
 * carries the decorating element's own measured baselines; pick the one on
 * the run's line (nearest), and use it only when it differs from the run's
 * own baseline by MORE than 1px (a real `vertical-align` shift — sub/sup are
 * ≥2px at body sizes) and by no more than the decorating font size (beyond
 * that it's a different line). Same-baseline children keep their own rounded
 * baseline, byte-identical to before. Exported for unit testing (not in the
 * package barrel).
 */
export function pickPropagatedBaseline(baselines: number[] | undefined, runBaselineY: number, decoFontSize: number): number {
  if (baselines == null || baselines.length === 0) return runBaselineY;
  let best = baselines[0];
  for (const b of baselines) {
    if (Math.abs(b - runBaselineY) < Math.abs(best - runBaselineY)) best = b;
  }
  const d = Math.abs(best - runBaselineY);
  return d > 1 && d <= decoFontSize ? best : runBaselineY;
}

function renderAppliedTextDecorations(
  el: CapturedElement,
  fallbackColor: string,
  run: AppliedDecorationRunCtx,
): string {
  const parts: string[] = [];
  const runAscent = run.fontAscent ?? run.fontSize * 0.8;
  // TRUE (unrounded) baseline of the run's glyphs — the skip-ink anchor and
  // the propagated-baseline comparison point.
  const runBaselineY = run.fragTop + runAscent;
  let decoIdx = 0;
  for (const pd of el.propagatedDecorations ?? []) {
    // Blink anchors a propagated decoration at the DECORATING box's line
    // (`offset_from_decorating_box`, `text_decoration_info.cc:325-335`).
    // Reconstruct that box's fragment top from its picked baseline minus its
    // captured FloatAscent (the baselines are captured integer-rounded, so
    // this carries up to 0.5px of capture rounding for shifted sub/sup lines;
    // same-line children use the run's own unrounded baseline).
    const pdAscent = pd.fontAscent ?? pd.fontSize * 0.8;
    const pdBaseline = pickPropagatedBaseline(pd.baselines, runBaselineY, pd.fontSize);
    parts.push(renderTextDecoration({
      textDecorationLine: pd.line, decorationColor: pd.color ?? fallbackColor, style: pd.style,
      segX: run.segX, fragTop: pdBaseline - pdAscent, runBaselineY, segWidth: run.segWidth,
      fontAscent: pdAscent, fontDescent: pd.fontDescent,
      fontSize: run.fontSize, fontFamily: run.fontFamily, fontWeight: run.fontWeight, fontStyle: el.styles.fontStyle,
      // `font-stretch` inherits, and `PropagatedDecoration` captures no stretch
      // of its own, so the decorated element's computed value is the decorating
      // box's too in every case capture can currently represent.
      fontStretch: el.styles.fontStretch,
      thicknessOverride: pd.thickness, underlineOffset: pd.underlineOffset,
      // `PropagatedDecoration` carries no position of its own, so the
      // decorated element's value applies.
      underlinePosition: el.styles.textUnderlinePosition,
      runText: run.runText, skipInk: el.styles.textDecorationSkipInk, features: run.features,
      runXOffsets: run.runXOffsets,
      metricsFontFamily: pd.fontFamily, metricsFontSize: pd.fontSize,
      metricsFontWeight: pd.fontWeight, metricsFontStyle: pd.fontStyle,
      idBase: run.idBase != null ? `${run.idBase}-${decoIdx++}` : undefined,
    }));
  }
  const ownLine = el.styles.textDecorationLine;
  if (ownLine != null && ownLine !== "" && ownLine !== "none") {
    const ownColor = (el.styles.textDecorationColor && el.styles.textDecorationColor !== "currentcolor")
      ? el.styles.textDecorationColor : fallbackColor;
    parts.push(renderTextDecoration({
      textDecorationLine: ownLine, decorationColor: ownColor, style: el.styles.textDecorationStyle,
      segX: run.segX, fragTop: run.fragTop, runBaselineY, segWidth: run.segWidth,
      fontAscent: run.fontAscent, fontDescent: run.fontDescent,
      fontSize: run.fontSize, fontFamily: run.fontFamily, fontWeight: run.fontWeight, fontStyle: el.styles.fontStyle,
      fontStretch: el.styles.fontStretch,
      thicknessOverride: el.styles.textDecorationThickness, underlineOffset: el.styles.textUnderlineOffset,
      underlinePosition: el.styles.textUnderlinePosition,
      runText: run.runText, skipInk: el.styles.textDecorationSkipInk, features: run.features,
      runXOffsets: run.runXOffsets,
      idBase: run.idBase != null ? `${run.idBase}-${decoIdx++}` : undefined,
    }));
  }
  return parts.join("");
}

const _bidi = bidiFactory();
// Quick test for any RTL code point (Hebrew + Arabic + Syriac + Thaana etc.).
const _RTL_RE = /[֐-ࣿיִ-ﻼ]/;

/**
 * The element's bidi override, in the shape `renderTextAsPath` wants. Only
 * `bidi-override` / `isolate-override` change any behaviour downstream; every
 * other `unicode-bidi` value leaves the algorithm to read the characters, which
 * is what it should do. Returns undefined when there is nothing to force, so the
 * common path stays byte-identical.
 */
function bidiOverrideFor(el: { styles: { direction?: string; unicodeBidi?: string } }):
  { direction: "ltr" | "rtl"; unicodeBidi: string } | undefined {
  const ub = el.styles.unicodeBidi;
  if (ub !== "bidi-override" && ub !== "isolate-override") return undefined;
  return { direction: el.styles.direction === "rtl" ? "rtl" : "ltr", unicodeBidi: ub };
}

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
  // DM-940: re-confirmed via probe — Chrome's per-char xOffset for a logical
  // `(` at an odd embedding level returns the visual x where the MIRRORED
  // glyph `)` is painted. So to faithfully reproduce Chrome's paint we
  // need to mirror the codepoint here (so the glyph we emit at that x is
  // the mirrored shape), AND we need the LOGICAL→VISUAL char-to-position
  // mapping to be correct — which it is, as long as the per-glyph walk
  // (`renderTextAsEmbedded`) uses the codePoints-based direction detect
  // from DM-940 instead of an xOffset-monotonicity heuristic. The earlier
  // attempt to skip mirroring when xOffsets were present was wrong: it
  // produced `)one(` (correct letters, wrong brackets) instead of `(one)`.
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

/**
 * DM-1055: mirror a soft-wrapped LINE's paired brackets using BiDi levels
 * resolved on the WHOLE logical paragraph, not the line in isolation. The bidi
 * paired-bracket algorithm (BD16) needs the full paragraph to pair `(` with `)`
 * — when a pair is split across wrapped lines, resolving the lone-bracket line by
 * itself leaves it at an odd embedding level and mirrors it, but Chrome does NOT
 * (in the full paragraph the pair resolves to an even level). `levels` is
 * `getEmbeddingLevels(fullText).levels`; `base` is the line's char offset into
 * `fullText`. `suppressGlyphChars` preserves length, so the line's bracket
 * positions align 1:1 with `levels[base + i]`. xOffsets pass through unchanged.
 */
function applyBidiAt(text: string, xOffsets: number[] | undefined, levels: number[], base: number): { text: string; xOffsets?: number[] } {
  let out = "";
  let any = false;
  for (let i = 0; i < text.length; i++) {
    const level = levels[base + i];
    if (level != null && level % 2 === 1) {
      const m = _bidi.getMirroredCharacter(text[i]);
      if (m != null) { out += m; any = true; continue; }
    }
    out += text[i];
  }
  return any ? { text: out, xOffsets } : { text, xOffsets };
}

/**
 * Test-only window into the DM-1055 fix: given the full logical paragraph and
 * its soft-wrapped lines, return each line's text after BiDi paired-bracket
 * mirroring resolved on the WHOLE paragraph (the logic `renderMultiSegmentText`
 * runs). Guards the invariant that a `(`…`)` pair split across wrapped lines is
 * NOT mirrored — per-line resolution would mirror the lone trailing bracket.
 */
export function __bidiMirrorLinesForTest(fullText: string, lines: string[], dir: "ltr" | "rtl"): string[] {
  const needs = dir === "rtl" || _RTL_RE.test(fullText);
  if (!needs) return lines.slice();
  const levels = _bidi.getEmbeddingLevels(fullText, dir).levels;
  let off = 0;
  return lines.map((ln) => {
    const idx = fullText.indexOf(ln, off);
    const base = idx >= 0 ? idx : off;
    off = base + ln.length;
    return applyBidiAt(ln, undefined, levels, base).text;
  });
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
  /** DM-782: emit the pseudoBox's `background-image` (gradient / url() layers)
   *  as SVG paint server defs + a covering `<rect>` per layer. Returned
   *  markup is the rect string(s), inserted BEFORE the glyph emit so the
   *  gradient paints under the text. Caller (main render loop) owns
   *  `defsParts` / `clipIdx` and provides this closure; standalone callers
   *  (unit tests) pass undefined and the gradient layers are skipped. */
  emitPseudoBoxBgLayers?: (pb: { x: number; y: number; width: number; height: number; backgroundImage: string; borderRadius?: number }) => string;
}

// Resolve OpenType features from font-variant-caps (DM-361, DM-444).
// Spec mapping:
//   small-caps      → [smcp]                  (lowercase → small caps)
//   all-small-caps  → [smcp, c2sc]            (lowercase + uppercase → small caps)
//   petite-caps     → [pcap]                  (lowercase → petite caps)
//   all-petite-caps → [pcap, c2pc]            (lowercase + uppercase → petite caps)
//   unicase         → [unic]                  (uppercase → small-cap height; lowercase same)
//   titling-caps    → [titl]                  (no case change; uppercase glyphs adjusted)
// The path renderer's synthesis layer (src/text-to-path.ts) applies the
// matching case-fold + scale when the active font lacks these OpenType
// features (Helvetica / Arial / SF Pro / Georgia / Times all do). Segment-
// level fontVariant (::first-line override) wins when set.
// The captured CSS `font-variant-emoji`, normalized for the renderer:
// `normal` / absent / unrecognized → undefined (no override). The three
// override keywords are genuine face-selection inputs — see the
// `RenderTextOptions.fontVariantEmoji` comment in text-to-path.ts.
function fontVariantEmojiOf(styles: { fontVariantEmoji?: string }): FontVariantEmojiOverride | undefined {
  const v = styles.fontVariantEmoji;
  return v === "text" || v === "emoji" || v === "unicode" ? v : undefined;
}

/**
 * The run's `font-synthesis` permissions, from the three captured longhands.
 *
 * Returns `undefined` when all three are `auto` — the initial value and the
 * overwhelmingly common case — so the options object is byte-identical to what
 * it was before this existed and no downstream decision changes. DM-1971.
 */
function fontSynthesisOf(styles: {
  fontSynthesisWeight?: string; fontSynthesisStyle?: string; fontSynthesisSmallCaps?: string;
}): FontSynthesisAllowance | undefined {
  const weight = styles.fontSynthesisWeight !== "none";
  const style = styles.fontSynthesisStyle !== "none";
  const smallCaps = styles.fontSynthesisSmallCaps !== "none";
  if (weight && style && smallCaps) return undefined;
  return { weight, style, smallCaps };
}

function resolveCapsFeatures(segVariant: string | undefined, elCaps: string | undefined): string[] | undefined {
  const v = segVariant != null && segVariant !== "" ? segVariant : (elCaps ?? "");
  if (/\ball-small-caps\b/.test(v)) return ["smcp", "c2sc"];
  if (/\ball-petite-caps\b/.test(v)) return ["pcap", "c2pc"];
  if (/\bsmall-caps\b/.test(v)) return ["smcp"];
  if (/\bpetite-caps\b/.test(v)) return ["pcap"];
  if (/\bunicase\b/.test(v)) return ["unic"];
  if (/\btitling-caps\b/.test(v)) return ["titl"];
  return undefined;
}

// DM-1117: resolve OpenType feature tags from the `font-variant-east-asian`,
// `font-variant-numeric`, and `font-variant-ligatures` longhands. CSS Fonts 4
// §6.x defines each keyword's feature mapping; these are the same tags Chrome
// activates. Without them `font-variant-east-asian: traditional` paints the
// simplified/JP default glyph (国) instead of the traditional form (國), and
// numeric variants render lining proportional figures regardless.
const EAST_ASIAN_FEATURE: Record<string, string> = {
  "jis78": "jp78", "jis83": "jp83", "jis90": "jp90", "jis04": "jp04",
  "simplified": "smpl", "traditional": "trad",
  "full-width": "fwid", "proportional-width": "pwid", "ruby": "ruby",
};
const NUMERIC_FEATURE: Record<string, string> = {
  "lining-nums": "lnum", "oldstyle-nums": "onum",
  "proportional-nums": "pnum", "tabular-nums": "tnum",
  "diagonal-fractions": "frac", "stacked-fractions": "afrc",
  "ordinal": "ordn", "slashed-zero": "zero",
};
export function resolveFontVariantFeatures(
  eastAsian: string | undefined,
  numeric: string | undefined,
  ligatures: string | undefined,
  /** Computed `letter-spacing` (`"normal"` or a px string). DM-1963. */
  letterSpacing?: string,
  /** Computed `text-rendering`. Only `optimizeSpeed` acts. DM-1963. */
  textRendering?: string,
  /** Computed `font-kerning` (`normal` | `none` | `auto`). DM-2048. */
  kerning?: string,
  /** Computed `font-variant-position` (`normal` | `sub` | `super`). DM-2048. */
  variantPosition?: string,
): string[] | undefined {
  const out: string[] = [];
  // font-kerning: none → -kern, transcribed from `FontFeatureRange::
  // FromFontDescription` (`platform/fonts/shaping/font_features.cc:39-50`,
  // rev 7d859f27). `normal` leaves kern on (HarfBuzz enables it by default)
  // and `auto` — Blink's `kAutoKerning`, the initial value — ALSO falls
  // through untouched, so only the literal `none` keyword pushes anything.
  // Blink emits `-vkrn` for a vertical run instead, but vertical
  // writing-mode text is rasterized before it reaches this pipeline
  // (`docs/reference/raster-image-fallback-cases.md` E6 / SK-1128), so the
  // horizontal tag is the only one reachable here. `-kern` is a disable, so
  // (per `font-features.ts`) the run is routed through HarfBuzz shaping —
  // fontkit has no way to switch a default-on feature off.
  if (kerning === "none") out.push("-kern");
  for (const kw of (eastAsian ?? "").split(/\s+/)) {
    const tag = EAST_ASIAN_FEATURE[kw];
    if (tag != null) out.push(tag);
  }
  for (const kw of (numeric ?? "").split(/\s+/)) {
    const tag = NUMERIC_FEATURE[kw];
    if (tag != null) out.push(tag);
  }
  // Ligature emission, transcribed from Blink's `FontFeatureRange::
  // FromFontDescription` (`platform/fonts/shaping/font_features.cc:52-86`,
  // rev 7d859f27). Each of the four rules below is one of its four `if`s, in
  // its order, reading the same three-state longhands:
  //
  //   default_is_off = TextRendering() == kOptimizeSpeed
  //   letter_spacing = LetterSpacing() != 0
  //   liga+clig OFF  if letter_spacing || common     == disabled || (common     == normal && default_is_off)
  //   dlig       ON  if !letter_spacing && discretionary == enabled
  //   hlig       ON  if !letter_spacing && historical    == enabled
  //   calt      OFF  if letter_spacing || contextual == disabled || (contextual == normal && default_is_off)
  //
  // DM-1963: `letter_spacing` and `default_is_off` are the two inputs this
  // function used to lack, and both are VETOES that outrank the author's
  // keyword — `font-variant-ligatures: common-ligatures` with a non-zero
  // `letter-spacing` still shapes without them, because the first term of the
  // disjunction wins. That is why these are not modeled as "the keyword unless
  // overridden": there is no keyword that survives letter-spacing.
  //
  // Blink pushes NOTHING for an explicitly-enabled `contextual`, since calt is
  // on by default in HarfBuzz. We used to push `calt`, which was harmless while
  // nothing could disable it and became a direct contradiction once
  // letter-spacing could — so it is dropped rather than made conditional.
  //
  // Disables are HarfBuzz feature strings (`-liga`); a run carrying one is
  // routed through HarfBuzz shaping, because fontkit's enable-only list cannot
  // switch a default-on feature off (see `font-features.ts`).
  //
  // The negative lookbehinds matter: `\bdiscretionary-ligatures\b` also matches
  // inside `no-discretionary-ligatures` (`-` is a word boundary), so the plain
  // patterns read the no- keywords as enables.
  const lig = ligatures ?? "";
  const none = /\bnone\b/.test(lig);
  // `none` computes every longhand to its disabled state, so it short-circuits
  // all four at once rather than being spelled out per longhand.
  const state = (on: RegExp, off: RegExp): "normal" | "enabled" | "disabled" =>
    none || off.test(lig) ? "disabled" : on.test(lig) ? "enabled" : "normal";
  const common = state(/(?<!no-)\bcommon-ligatures\b/, /\bno-common-ligatures\b/);
  const discretionary = state(/(?<!no-)\bdiscretionary-ligatures\b/, /\bno-discretionary-ligatures\b/);
  const historical = state(/(?<!no-)\bhistorical-ligatures\b/, /\bno-historical-ligatures\b/);
  const contextual = state(/(?<!no-)\bcontextual\b/, /\bno-contextual\b/);

  // Case-INSENSITIVE: the CSS keyword is `optimizeSpeed`, but Chrome's computed
  // style serializes it all-lowercase (`optimizespeed`), so an exact match
  // against the spec spelling silently never fires. Caught by disabling the
  // feature and finding the answer did not move — the arm that reads this was
  // byte-identical either way while the letter-spacing arm shifted 3px.
  const defaultIsOff = textRendering?.toLowerCase() === "optimizespeed";
  const spaced = letterSpacingIsNonZero(letterSpacing);

  if (spaced || common === "disabled" || (common === "normal" && defaultIsOff)) out.push("-liga", "-clig");
  if (!spaced && discretionary === "enabled") out.push("dlig");
  if (!spaced && historical === "enabled") out.push("hlig");
  if (spaced || contextual === "disabled" || (contextual === "normal" && defaultIsOff)) out.push("-calt");

  // font-variant-position → subs/sups, transcribed from `FontFeatureRange::
  // FromFontDescription` (`platform/fonts/shaping/font_features.cc:230-239`,
  // rev 7d859f27) — the two keywords are mutually exclusive so at most one
  // tag is pushed, matching Blink's `if`/`if` (not `if`/`else if`, but the
  // computed value can only be one of `sub` or `super` at a time).
  if (variantPosition === "sub") out.push("subs");
  else if (variantPosition === "super") out.push("sups");

  return out.length > 0 ? out : undefined;
}

// DM-2048: `chws` is enabled by default whenever `text-spacing-trim: normal`
// makes `ShouldTrimAdjacent` true (`text_spacing_trim.h:23-25`, rev
// 7d859f27) — Domotion never captures a non-`normal` `text-spacing-trim`, so
// this is unconditional. Blink appends the default AFTER walking the
// author's `font-feature-settings`, and skips it when the author's list
// already carries `chws` (any value) or a non-zero `halt`/`palt`
// (`platform/fonts/shaping/font_features.cc:197-228`, rev 7d859f27). A
// vertical run would use `vchw` instead, but vertical writing-mode text is
// rasterized before it reaches this pipeline (`docs/reference/
// raster-image-fallback-cases.md` E6 / SK-1128), so only the horizontal tag
// is reachable here. `chws` is GPOS-only and enable-only, so fontkit can
// carry it without a HarfBuzz reroute.
export function resolveChwsFeature(ffsFeatures: string[] | undefined): string[] | undefined {
  if (ffsFeatures != null) {
    for (const f of ffsFeatures) {
      const enabled = !f.startsWith("-");
      const tag = enabled ? f.split("=")[0] : f.slice(1);
      if (tag === "chws") return undefined;
      if (enabled && (tag === "halt" || tag === "palt")) return undefined;
    }
  }
  return ["chws"];
}

/** Blink's `LetterSpacing() != 0` — `normal` and `0px` are both zero. DM-1963. */
function letterSpacingIsNonZero(value: string | undefined): boolean {
  if (value == null || value === "" || value === "normal") return false;
  const n = parseFloat(value);
  return Number.isFinite(n) && n !== 0;
}

// DM-564: parse `font-feature-settings` into the OpenType tag list fontkit
// expects from `font.layout(text, features)`. Author-set tags like `cv11`
// (Inter's single-story `a` alternate) drive lookup substitutions at shape
// time; without applying them, Inter / Geist / Roboto Flex / etc. render their
// default `a` instead of the brand's intended cv-alternate, and the page
// looks like a different typeface entirely.
//
// CSS syntax (per CSS Fonts 4 §6.4):
//   font-feature-settings: <feature-tag-value> #
//   <feature-tag-value> = <opentype-tag> [ <integer [0,∞]> | on | off ]?
//   Default value when omitted is 1 (enabled).
//
// Every entry is kept, VALUE INCLUDED, the way Blink keeps it: each setting is
// appended to the HarfBuzz feature array verbatim
// (`FontFeatureRange::FromFontDescription`,
// `platform/fonts/shaping/font_features.cc:203-225`, rev 7d859f27), and
// HarfBuzz honors a zero by leaving the feature's lookup mask unset. Entries
// are HarfBuzz feature strings: `tag` (value 1), `-tag` (value 0), `tag=N`
// (N > 1). A previous revision DROPPED zero/off entries as an accommodation of
// fontkit's enable-only list, which made `font-feature-settings: "liga" 0`
// render WITH ligatures where Chrome renders without — the disable now
// survives parsing, and runs carrying one are shaped by HarfBuzz (see
// `font-features.ts` / `fontFeatureValueShapingOverride`).
export function parseFontFeatureSettings(css: string | undefined): string[] | undefined {
  if (css == null || css === "" || css === "normal") return undefined;
  const out: string[] = [];
  // Match `"tag"` or `'tag'` optionally followed by integer/on/off.
  const re = /["']([a-zA-Z0-9]{4})["']\s*(\d+|on|off)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) != null) {
    const tag = m[1];
    const value = m[2];
    const num = value == null || value === "on" ? 1 : value === "off" ? 0 : parseInt(value, 10);
    if (num === 0) {
      out.push(`-${tag}`);
      continue;
    }
    // `numr` / `dnom` are kept verbatim, the way Blink keeps every
    // `font-feature-settings` entry (`font_features.cc:203-225` above) — a
    // previous revision remapped them to `sups`/`subs` because fontkit only
    // fires a font's `numr`/`dnom` GSUB lookups inside a `frac` run and a bare
    // `numr` was a fontkit no-op. That was a fitted stand-in (measured "SF
    // Pro's sups '1' sits ~0.8px higher than its numr '1'"), not what Chrome
    // does: Chrome requests the real `numr`/`dnom` tags globally, and
    // HarfBuzz's `hb_ot_shape_collect_features` registers them as ordinary
    // user features (`hb-ot-shape.cc:351-353`, rev 4de187d) — the automatic
    // fraction-slash masking at `:685-744` is an ADDITIONAL restriction for
    // the `frac` auto-detection path and does not gate an explicitly
    // requested global feature. `featureListNeedsHbShaping` now routes any
    // run carrying `numr`/`dnom` through the HarfBuzz proxy
    // (`fontFeatureValueShapingOverride`) instead of fontkit, so the real
    // GSUB lookup applies.
    out.push(num === 1 ? tag : `${tag}=${num}`);
  }
  return out.length > 0 ? out : undefined;
}

type FeatureValueTable = NonNullable<CapturedElement["styles"]["fontFeatureValues"]>[string];

/** Transcription of FontVariantAlternates::Resolve (Chromium 7d859f27). */
export function resolveFontVariantAlternates(
  css: string | undefined,
  fontFamily: string,
  tables: CapturedElement["styles"]["fontFeatureValues"],
): string[] | undefined {
  if (css == null || css === "" || css === "normal") return undefined;
  const families = fontFamily.match(/(?:"[^"]*"|'[^']*'|[^,])+/g)?.map((name) =>
    name.trim().replace(/^(['"])(.*)\1$/, "$2").toLowerCase(),
  ) ?? [];
  // Blink resolves once per family while walking the CSS stack. Choose the
  // first family that owns an alias table; aliases declared for another family
  // must never leak into this request.
  const family = families.find((name) => tables?.[name] != null);
  const table: FeatureValueTable | undefined = family == null ? undefined : tables?.[family];
  const out: string[] = [];
  const emitSingle = (fn: string, category: keyof FeatureValueTable, tags: string[]) => {
    const m = new RegExp(`${fn}\\(\\s*([^\\s,)]+)\\s*\\)`, "i").exec(css);
    const values = m == null ? undefined : table?.[category]?.[m[1]];
    if (values?.length === 1) for (const tag of tags) out.push(`${tag}=${values[0]}`);
  };
  emitSingle("swash", "swash", ["swsh", "cswh"]);
  emitSingle("ornaments", "ornaments", ["ornm"]);
  emitSingle("annotation", "annotation", ["nalt"]);
  emitSingle("stylistic", "stylistic", ["salt"]);
  for (const m of css.matchAll(/styleset\(\s*([^)]*)\)/gi)) {
    for (const alias of m[1].trim().split(/\s+/)) {
      for (const value of table?.styleset?.[alias] ?? []) if (value <= 99) out.push(`ss${String(value).padStart(2, "0")}`);
    }
  }
  for (const m of css.matchAll(/character-variant\(\s*([^)]*)\)/gi)) {
    for (const alias of m[1].trim().split(/\s+/)) {
      const values = table?.characterVariant?.[alias];
      if (values != null && values.length >= 1 && values.length <= 2 && values[0] <= 99) {
        out.push(`cv${String(values[0]).padStart(2, "0")}${values.length === 2 ? `=${values[1]}` : ""}`);
      }
    }
  }
  if (/\bhistorical-forms\b/i.test(css)) out.push("hist");
  return out.length ? out : undefined;
}

function elementFontFeatures(el: CapturedElement, fontFamily = el.styles.fontFamily): string[] | undefined {
  const alternates = resolveFontVariantAlternates(el.styles.fontVariantAlternates, fontFamily, el.styles.fontFeatureValues);
  return mergeFeatureLists(alternates, parseFontFeatureSettings(el.styles.fontFeatureSettings));
}

/** Shared selected-face input for the post-capture color-glyph classifier. */
export function capturedTextSegmentFontFeatures(
  el: CapturedElement,
  seg: TextSegment,
): string[] | undefined {
  const family = seg.fontFamily ?? el.styles.fontFamily;
  const ffs = elementFontFeatures(el, family);
  return mergeFeatureLists(
    mergeFeatureLists(
      mergeFeatureLists(
        resolveCapsFeatures(seg.fontVariant, el.styles.fontVariantCaps),
        resolveFontVariantFeatures(
          el.styles.fontVariantEastAsian, el.styles.fontVariantNumeric,
          el.styles.fontVariantLigatures, el.styles.letterSpacing,
          el.styles.textRendering, el.styles.fontKerning,
          el.styles.fontVariantPosition,
        ),
      ),
      ffs,
    ),
    resolveChwsFeature(ffs),
  );
}

// DM-578: parse `font-variation-settings` into the `{ axisTag: value }` shape
// fontkit's `font.getVariation()` expects. Pages built with next/font or
// hand-tuned variable-font setups (framer.com body P captures
// `font-variation-settings: "opsz" 30, "wght" 450`) drive `wght` / `opsz` /
// custom axes directly, overriding the CSS-weight-derived defaults. Without
// this the variable webfont renders at the wrong instance — slightly wrong
// stem thickness and counter shapes vs Chromium.
//
// CSS syntax (per CSS Fonts 4 §6.3):
//   font-variation-settings: <feature-tag-value> #
//   <feature-tag-value> = <opentype-axis-tag> <number>
//
// Returns undefined when the value is missing / `normal`.
export function parseFontVariationSettings(css: string | undefined): Record<string, number> | undefined {
  if (css == null || css === "" || css === "normal") return undefined;
  const out: Record<string, number> = {};
  // Axis tags are 4-character codes (alphanumeric); values can be integer or float.
  const re = /["']([a-zA-Z0-9]{4})["']\s*(-?\d+(?:\.\d+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) != null) {
    out[m[1]] = parseFloat(m[2]);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Preserve `font-optical-sizing:none` beside author axes without inventing an
 * OpenType coordinate. The non-enumerable marker is ignored by axis loops and
 * cache serialization; font resolution consumes it only to skip automatic
 * size-derived `opsz`. Explicit `"opsz"` remains an ordinary enumerable axis
 * and therefore keeps CSS Fonts' precedence. */
function opticalVariationSettings(el: Pick<CapturedElement, "styles">): Record<string, number> | undefined {
  const axes = parseFontVariationSettings(el.styles.fontVariationSettings);
  const logical = parseFloat(el.styles.fontLogicalSize ?? el.styles.fontSize);
  const computed = parseFloat(el.styles.fontComputedSize ?? el.styles.fontSize);
  const needsSizeSpaces = Number.isFinite(logical) && Number.isFinite(computed)
    && (logical !== parseFloat(el.styles.fontSize) || computed !== parseFloat(el.styles.fontSize));
  if (el.styles.fontOpticalSizing !== "none" && !needsSizeSpaces) return axes;
  const marked = axes ?? {};
  if (el.styles.fontOpticalSizing === "none") Object.defineProperty(marked, "__dmOpticalSizingNone", { value: true, enumerable: false });
  if (Number.isFinite(logical)) Object.defineProperty(marked, "__dmLogicalFontSize", { value: logical, enumerable: false });
  if (Number.isFinite(computed)) Object.defineProperty(marked, "__dmComputedFontSize", { value: computed, enumerable: false });
  return marked;
}

// Exported for the shaping conformance oracle (DM-1983), which must combine the
// run's feature sources through the SHIPPED merge rather than a second one that
// could drift from it — the same reason it calls `parseFontFeatureSettings` and
// `resolveFontVariantFeatures` instead of re-deriving either.
export function mergeFeatureLists(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
  if (a == null) return b;
  if (b == null) return a;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of a) { if (!seen.has(t)) { seen.add(t); out.push(t); } }
  for (const t of b) { if (!seen.has(t)) { seen.add(t); out.push(t); } }
  return out;
}

/**
 * DM-680: anisotropic-ancestor scale correction. When the element sits inside
 * a `transform: scale(sx, sy)` with sx ≠ sy, the capture script already
 * folded the geometric mean of (sx, sy) into fontSize / fontAscent / fontDescent
 * — that produces correct glyph metrics for the uniform / isotropic case but
 * leaves an axis ratio still to apply (Chrome paints glyphs into post-transform
 * device space, where width scales by sx and height by sy independently). Wrap
 * the text emission in a per-axis correction `<g transform=...>` pivoted around
 * the text origin so the net visual scale is exactly (sx, sy).
 *
 * DM-822: callers that emit per-char positions FROM CAPTURED xOffsets must
 * also call `anisotropicCorrectionXOffsets` to pre-divide those xOffsets by
 * (cx, cy). The captured xOffsets are post-transform (= native_x × sx)
 * already; without the pre-division, the wrap's outer scale multiplies them
 * a second time and inter-glyph spacing comes out 1.5×–2× too wide on
 * fixtures like `21-deep-anisotropic-scale`'s `scale(1.6, 0.7)` box. The
 * per-axis (cx, cy) factors are `sx/geo` and `sy/geo` so that geo×cx == sx
 * exactly; dividing xOffsetsRel by cx (which is what the wrap is about to
 * multiply by) is the exact inverse and leaves the post-wrap glyph
 * positions equal to the captured xOffsets.
 */
function getAnisotropicCorrectionFactors(el: { cumScaleX?: number; cumScaleY?: number }): { cx: number; cy: number } | null {
  const sx = el.cumScaleX;
  const sy = el.cumScaleY;
  if (sx == null || sy == null || sx === sy) return null;
  const geo = Math.sqrt(sx * sy);
  if (geo === 0) return null;
  const cx = sx / geo;
  const cy = sy / geo;
  if (Math.abs(cx - 1) < 1e-4 && Math.abs(cy - 1) < 1e-4) return null;
  return { cx, cy };
}

function anisotropicCorrectionXOffsets(el: { cumScaleX?: number; cumScaleY?: number }, xOffsetsRel: number[] | undefined): number[] | undefined {
  if (xOffsetsRel == null) return xOffsetsRel;
  const f = getAnisotropicCorrectionFactors(el);
  if (f == null) return xOffsetsRel;
  // xOffsetsRel is in user-space, relative to the text origin (the wrap's
  // pivot). Dividing by cx pre-shrinks the inter-glyph spacing so that the
  // wrap's scale(cx, cy) multiplies it back to the captured xOffsets.
  return xOffsetsRel.map((v) => v / f.cx);
}

function anisotropicCorrectionWrap(el: { cumScaleX?: number; cumScaleY?: number; textLeft?: number; textTop?: number; x: number; y: number }, body: string): string {
  const f = getAnisotropicCorrectionFactors(el);
  if (f == null) return body;
  // Pivot around the text origin so the correction stretches glyphs in place
  // rather than translating the whole block.
  const px = el.textLeft ?? el.x;
  const py = el.textTop ?? el.y;
  return `<g transform="translate(${r(px)} ${r(py)}) scale(${r(f.cx)} ${r(f.cy)}) translate(${r(-px)} ${r(-py)})">${body}</g>`;
}

/**
 * Render a single-line text element.
 */
export function renderSingleLineText(opts: RenderTextOpts): string {
  const _ts = textStrokeParams(opts.el.styles);
  const { el, clipId, fillColor } = opts;
  // Raster fallback (DM-626 follow-up to DM-583): when the only segment
  // is a pseudo whose codepoints fontkit can't shape (e.g. icon-font
  // PUA codepoints in a font we don't have access to), CAPTURE_SCRIPT
  // marks `rasterRect` and `rasterizeBitmapGlyphs` fills in
  // `rasterDataUri` with a screenshot of Chromium's actual paint.
  // Path emission for these glyphs strips the font's left-side
  // bearing so the visible glyph drifts left of where Chrome paints
  // it (DM-596). Use the screenshot instead — pixel-faithful and
  // anchored at the position Chromium painted from.
  const ssSeg = (el.textSegments != null && el.textSegments.length === 1) ? el.textSegments[0] : undefined;
  if (ssSeg != null && ssSeg.rasterDataUri != null && ssSeg.rasterRect != null) {
    const rr = ssSeg.rasterRect;
    // DM-1271: skip the line-box clip when the rect was grown to a color emoji's
    // overflowing painted square (see the multi-segment path for the rationale).
    const rasterClip = ssSeg.rasterEmojiSide != null ? "" : ` clip-path="url(#${clipId})"`;
    return `<image href="${ssSeg.rasterDataUri}" x="${r(rr.x)}" y="${r(rr.y)}" width="${r(rr.width)}" height="${r(rr.height)}" preserveAspectRatio="none"${rasterClip}/>`;
  }
  const fontSize = parseFloat(el.styles.fontSize) || 14;
  const fontFamily = el.styles.fontFamily;
  const fontWeight = el.styles.fontWeight;
  const tl = el.textLeft ?? el.x + 4;
  const tt = el.textTop ?? el.y;

  // DM-874: a MathML stretchy fence operator (`<mo>` whose text is a single
  // bracket/paren/brace) is painted by Chromium centered on the math axis and
  // stretched to wrap its content — the `<mo>` element box reflects that, but
  // the captured text baseline does not, so baseline placement lands the fence
  // several px too low. Fit the glyph to the captured element box instead.
  if (el.tag === "mo" && isStretchyFenceChar(el.text) && el.height > 0) {
    const fence = renderStretchyFenceGlyph(
      el.text.trim(), tl, el.y, el.height,
      { fontSize, fontFamily, fontWeight, fontStyle: el.styles.fontStyle, fontStretch: el.styles.fontStretch },
      fillColor,
    );
    if (fence != null) return fence;
    // Fall through to normal baseline rendering when the glyph can't be fitted.
  }

  // Path mode: convert to <path> outlines. When the capture layer recorded
  // per-character xOffsets for this single-line segment, pass them through so
  // each glyph is anchored at the exact x Chrome painted (closes per-char
  // drift). Falls back to Chrome's measured width for uniform scaling.
  const singleSeg = (el.textSegments != null && el.textSegments.length === 1) ? el.textSegments[0] : undefined;
  const pathTextRawSrc = singleSeg != null ? singleSeg.text : el.text;
  const pathTextRaw = suppressGlyphChars(pathTextRawSrc, singleSeg);
  const xOffsetsRelRaw = singleSeg?.xOffsets != null ? singleSeg.xOffsets.map((v) => v - tl) : undefined;
  const dir = el.styles.direction === "rtl" ? "rtl" : "ltr";
  const reordered = applyBidi(pathTextRaw, xOffsetsRelRaw, dir);
  const pathText = reordered.text;
  // DM-822: pre-divide xOffsetsRel by cx when an anisotropic correction
  // wrap will multiply positions on emit. No-op for uniform-scale text.
  const xOffsetsRel = anisotropicCorrectionXOffsets(el, reordered.xOffsets);
  const ffsFeatures = elementFontFeatures(el, singleSeg?.fontFamily ?? fontFamily);
  const features = mergeFeatureLists(
    mergeFeatureLists(
      mergeFeatureLists(
        resolveCapsFeatures(singleSeg?.fontVariant, el.styles.fontVariantCaps),
        resolveFontVariantFeatures(el.styles.fontVariantEastAsian, el.styles.fontVariantNumeric,
          el.styles.fontVariantLigatures, el.styles.letterSpacing, el.styles.textRendering,
          el.styles.fontKerning, el.styles.fontVariantPosition),
      ),
      ffsFeatures,
    ),
    resolveChwsFeature(ffsFeatures),
  );
  const variationSettings = opticalVariationSettings(el);
  // DM-495: when the only segment is a pseudo with its own typography
  // overrides (color / fontSize / fontWeight / fontAscent), prefer those
  // over the host element's values. The capture layer carries pseudo-
  // specific overrides on the segment, but the singleSeg path was reading
  // host-level fields exclusively, so a `.marker::after { color: white }`
  // pseudo painted in the marker's own color (typically inherited black).
  const segColor = singleSeg?.color ?? fillColor;
  const segFontSize = singleSeg?.fontSize ?? fontSize;
  const segFontWeight = singleSeg?.fontWeight ?? fontWeight;
  const segAscent = singleSeg?.fontAscent ?? el.fontAscent;
  // DM-513: pseudo-element font-family override (e.g. icon font on
  // `[class^="icon-"]:before { font-family: "sdicon" }`).
  const segFontFamily = singleSeg?.fontFamily ?? fontFamily;
  // Pseudo-element font-style override (Slashdot's `.carouselHeading::after`
  // is italic on a non-italic host). The multi-segment path already did the
  // `seg.fontStyle ?? el.styles.fontStyle` fallback below; the single-segment
  // path was reading host fontStyle exclusively, so a pseudo's italic was
  // silently swallowed.
  const segFontStyle = singleSeg?.fontStyle ?? el.styles.fontStyle;
  // DM-507: when the single segment is a pseudo with its own paint box
  // (background-color / border-radius / border), emit a <rect> behind the
  // glyphs. Same as the multi-segment path; without this the badge / pill
  // bg never paints when the pseudo is the only text on the host.
  const singleSegBoxMarkup = (singleSeg?.pseudoBox != null)
    ? renderSingleSegPseudoBox(singleSeg.pseudoBox, opts.emitPseudoBoxBgLayers)
    : "";
  // DM-832: MathML token elements (`<mi>` / `<mo>` / `<mn>` / `<mtext>`, the
  // non-stretchy cases — stretchy fences returned above) are positioned by
  // Chromium's math layout so the element border box is tight to the glyph
  // ink. The captured `el.y` is the ink top and `el.height` the ink height,
  // where ordinary inline text would use the line-box top + font ascent. That
  // font-ascent baseline sits several px too low for tall operators (∑ ∫) and
  // a few px off for letters, which is the residual vertical drift the
  // `34-mathml-layout` fixture flagged.
  //
  // Place the baseline by splitting Chrome's captured ink box in the SAME
  // ascent:descent ratio the rendered glyph has: `baseline = el.y + el.height
  // * inkAscent / (inkAscent + inkDescent)`. Scaling by Chrome's own
  // `el.height` (rather than the glyph's absolute ink ascent) keeps the fit
  // correct even when the math glyph we draw differs slightly from Chrome's:
  // `font-family: math` resolves to Times here and the operators / Greek
  // letters fall back to STIX, whose per-glyph ink ascent runs ~0.5 px short
  // of Chrome's painted glyph. Anchoring on the absolute ink ascent transferred
  // that mismatch straight into a baseline error big enough to trip the diff on
  // π / β; the proportional split absorbs it because it only borrows the
  // glyph's ascent:descent RATIO, not its absolute size.
  let renderY = tt;
  let renderAscent = segAscent;
  if (MATH_TOKEN_TAGS.has(el.tag ?? "") && el.height > 0) {
    const ink = measureInkMetrics(pathText, {
      fontSize: segFontSize, fontFamily: segFontFamily, fontWeight: segFontWeight,
      fontStyle: segFontStyle, fontStretch: el.styles.fontStretch,
      lang: el.styles.lang, variationSettings, features,
    });
    if (ink != null) {
      const inkTotal = ink.inkAscent + ink.inkDescent;
      if (inkTotal > 0) {
        renderY = el.y;
        renderAscent = el.height * (ink.inkAscent / inkTotal);
      }
    }
  }
  const result = renderTextAsPath(pathText, tl, renderY, {
    fontSize: segFontSize, fontFamily: segFontFamily, fontWeight: segFontWeight, fill: segColor,
    targetWidth: el.textWidth, xOffsets: xOffsetsRel, fontStyle: segFontStyle,
    ascentOverride: renderAscent, features, lang: el.styles.lang, variationSettings,
    textStrokeWidth: _ts.width, textStrokeColor: _ts.color, paintOrder: _ts.paintOrder,
    dottedCircleMarks: singleSeg?.dottedCircleMarks, bidiOverride: bidiOverrideFor(el),
    fontStretch: el.styles.fontStretch, fontVariantEmoji: fontVariantEmojiOf(el.styles),
    fontSynthesis: fontSynthesisOf(el.styles),
  });
  // Decorations anchor on the text fragment TOP (`tt`) + the captured
    // FloatAscent — the same pair Blink's decoration offsets are expressed
    // against (`local_origin_.line_over` + `FontMetrics` in
    // `core/paint/text_decoration_info.cc`). No pre-rounding here: the
    // paint-time snap is applied per line style inside `emitDecorationLine`.
    // DM-1723/DM-1725: the element's own decoration plus every ancestor
    // decorating box's propagated entry paint independently (Blink's
    // AppliedTextDecorations accumulation).
    const decoMarkup = renderAppliedTextDecorations(el, segColor, {
      segX: tl, fragTop: tt, fontAscent: segAscent, fontDescent: el.fontDescent,
      segWidth: el.textWidth ?? 0,
      fontSize: segFontSize, fontFamily: segFontFamily, fontWeight: segFontWeight,
      runText: pathText, features, runXOffsets: xOffsetsRel ?? undefined,
      idBase: `${clipId}-dec`,
    });
    // Per-char raster overlays (SK-1090). Emoji / color-bitmap codepoints in
    // the middle of plain-text runs get stamped on top of the path output.
    const rasterOverlay = singleSeg != null ? rasterGlyphOverlays(singleSeg, fontSize, clipId) : "";
    // Wrap the path-mode output in the element's clip-path only when the
    // element actually overflow-clips (DM-305). Default `overflow: visible`
    // lets text extend past the box edge, so the unconditional clip from
    // an earlier draft over-cut text on `word-wrap: break-word` paragraphs
    // whose last char measured a fraction of a px past `el.x + el.width`.
    //
    // DM-783: when the pseudo carries a CSS `transform`, wrap box + glyphs +
    // decoration + raster overlay together so the rotation/scale pivots
    // around the captured `transform-origin` and the text rotates WITH the
    // box (e.g. a `::after { transform: rotate(-15deg) }` rotated pill keeps
    // its label aligned to the pill, not the host's baseline).
    const emphasisMarks = renderTextEmphasisMarks(el, segColor);
    const inner = `${singleSegBoxMarkup}${result}${decoMarkup}${rasterOverlay}${emphasisMarks}`;
    const transformed = singleSeg?.pseudoBox != null
      ? wrapPseudoPaintEffects(singleSeg.pseudoBox, inner)
      : inner;
  if (opts.overflowClip) {
    return anisotropicCorrectionWrap(el, `<g clip-path="url(#${clipId})">${transformed}</g>`);
  }
  return anisotropicCorrectionWrap(el, transformed);
}

// Build the <rect> (+ optional background-image layers + per-side borders)
// painted behind a single pseudo-element segment's glyphs (DM-507). Extracted
// verbatim from renderSingleLineText's inline IIFE — the multi-segment path
// keeps its own copy. The caller only invokes this when the pseudo has a box.
function renderSingleSegPseudoBox(
  pb: NonNullable<TextSegment["pseudoBox"]>,
  emitPseudoBoxBgLayers: RenderTextOpts["emitPseudoBoxBgLayers"],
): string {
  const fillAttr = pb.backgroundColor != null ? ` fill="${esc(pb.backgroundColor)}"` : ` fill="none"`;
  // Clamp the pseudo's border-radius to half the SHORTER side so a pill
  // (e.g. `border-radius: 100px` on a 90×40 button) renders as a capsule
  // — flat top/bottom + fully-rounded ends — instead of an ellipse with
  // rx and ry capped independently. Mirrors the inset() clip-path fix
  // (CSS Backgrounds 3 §5.5 uniform-scale rule) for the pseudo-box path.
  const clampedBR = pb.borderRadius != null && pb.borderRadius > 0
    ? Math.min(pb.borderRadius, pb.width / 2, pb.height / 2) : 0;
  const rxAttr = clampedBR > 0 ? ` rx="${r(clampedBR)}" ry="${r(clampedBR)}"` : "";
  const strokeAttr = pb.borderWidth != null && pb.borderWidth > 0 && pb.borderColor != null
    ? ` stroke="${esc(pb.borderColor)}" stroke-width="${r(pb.borderWidth)}"` : "";
  // DM-782: gradient/url() background-image layers paint BETWEEN the flat
  // bg-color (bottom) and the text glyphs (top). Caller threads defsParts
  // + clipIdx through `emitPseudoBoxBgLayers`; when that closure is absent
  // (standalone callers / unit tests) we just skip the gradient layers.
  const bgImageMarkup = (pb.backgroundImage != null && pb.backgroundImage !== "none" && pb.backgroundImage !== "" && emitPseudoBoxBgLayers != null)
    ? emitPseudoBoxBgLayers({ x: pb.x, y: pb.y, width: pb.width, height: pb.height, backgroundImage: pb.backgroundImage, borderRadius: clampedBR > 0 ? clampedBR : undefined })
    : "";
  return `<rect x="${r(pb.x)}" y="${r(pb.y)}" width="${r(pb.width)}" height="${r(pb.height)}"${rxAttr}${fillAttr}${strokeAttr}/>${bgImageMarkup}${renderPseudoBoxPerSideBorders(pb)}`;
}

/**
 * Render multi-segment text (mixed content like: <p>Text <code>x</code> more</p>).
 */
export function renderMultiSegmentText(opts: RenderTextOpts, segments: TextSegment[]): string {
  const _ts = textStrokeParams(opts.el.styles);
  const { el, clipId, fillColor } = opts;
  const elFontSize = parseFloat(el.styles.fontSize) || 14;
  const fontFamily = el.styles.fontFamily;
  const elFontWeight = el.styles.fontWeight;
  const parts: string[] = [];

  const dir = el.styles.direction === "rtl" ? "rtl" : "ltr";
  // DM-1055: resolve BiDi embedding levels on the WHOLE paragraph (`el.text`)
  // once, so a paired bracket split across soft-wrapped segments mirrors the
  // same as Chrome. Resolving per-segment (below) sees a lone bracket and
  // over-mirrors it. `_segBidiOffset` walks each segment's slice of the levels.
  const _segBidiNeeded = dir === "rtl" || _RTL_RE.test(el.text);
  const _segFullLevels = _segBidiNeeded ? _bidi.getEmbeddingLevels(el.text, dir).levels : null;
  let _segBidiOffset = 0;
  const elVariationSettings = opticalVariationSettings(el);
  // Per-fragment counter feeding each segment's decoration clip-path id base
  // (patterned decoration styles mint `<clipPath>`s; ids must stay unique
  // across the element's fragments).
  let _decoSegIdx = 0;
  for (const seg of segments) {
    // Color-bitmap glyph fallback (SK-1058): CAPTURE_SCRIPT marked this
    // segment with a Playwright screenshot of Chrome's actual raster (e.g.
    // U+2713 ✓, which Chrome paints via Apple Color Emoji's sbix bitmap that
    // fontkit can't convert to <path>). Stamp the PNG directly at the
    // segment's layout box. Skip the path pipeline — the rasterRect was sized
    // to the full line box, so y/height here use that same rect so the image
    // lands exactly where Chrome painted it.
    if (seg.rasterDataUri != null && seg.rasterRect != null) {
      // DM-1271: when the rect was grown to a color emoji's painted square (its
      // advance overflows the line box), skip the line-box clip — an inline
      // pseudo doesn't clip overflow, so Chrome paints the emoji past the line
      // box and clipping it back re-cuts the glyph's top/bottom.
      const rasterClip = seg.rasterEmojiSide != null ? "" : ` clip-path="url(#${clipId})"`;
      parts.push(`<image href="${seg.rasterDataUri}" x="${r(seg.rasterRect.x)}" y="${r(seg.rasterRect.y)}" width="${r(seg.rasterRect.width)}" height="${r(seg.rasterRect.height)}" preserveAspectRatio="none"${rasterClip}/>`);
      continue;
    }
    // DM-497: pseudo-element paint box. ::before / ::after with their own
    // background-color or border-radius (badges / pills / chips) need a
    // <rect> behind the text glyphs. Captured at CAPTURE_SCRIPT time once
    // seg.x/y is in its final viewport-relative position; we just emit it.
    //
    // DM-783: per-segment buffer so a pseudo's `transform` wraps box + glyphs
    // + decoration + raster overlay together (the rotation/scale must pivot
    // around the pseudo's box, not the host's baseline). Non-pseudo segments
    // — and pseudos without a transform — flush straight into `parts` with no
    // wrapping, preserving the prior emit order byte-for-byte.
    const segParts: string[] = [];
    if (seg.pseudoBox != null) {
      const pb = seg.pseudoBox;
      const fillAttr = pb.backgroundColor != null ? ` fill="${esc(pb.backgroundColor)}"` : ` fill="none"`;
      // Clamp the pseudo's border-radius to half the SHORTER side so a pill
    // (e.g. `border-radius: 100px` on a 90×40 button) renders as a capsule
    // — flat top/bottom + fully-rounded ends — instead of an ellipse with
    // rx and ry capped independently. Mirrors the inset() clip-path fix
    // (CSS Backgrounds 3 §5.5 uniform-scale rule) for the pseudo-box path.
    const clampedBR = pb.borderRadius != null && pb.borderRadius > 0
      ? Math.min(pb.borderRadius, pb.width / 2, pb.height / 2) : 0;
    const rxAttr = clampedBR > 0 ? ` rx="${r(clampedBR)}" ry="${r(clampedBR)}"` : "";
      const strokeAttr = pb.borderWidth != null && pb.borderWidth > 0 && pb.borderColor != null
        ? ` stroke="${esc(pb.borderColor)}" stroke-width="${r(pb.borderWidth)}"` : "";
      // DM-782: gradient/url() background-image layers paint between flat
      // bg-color (bottom) and text glyphs (top). See `RenderTextOpts.
      // emitPseudoBoxBgLayers` for the closure-injection rationale.
      const bgImageMarkup = (pb.backgroundImage != null && pb.backgroundImage !== "none" && pb.backgroundImage !== "" && opts.emitPseudoBoxBgLayers != null)
        ? opts.emitPseudoBoxBgLayers({ x: pb.x, y: pb.y, width: pb.width, height: pb.height, backgroundImage: pb.backgroundImage, borderRadius: clampedBR > 0 ? clampedBR : undefined })
        : "";
      segParts.push(`<rect x="${r(pb.x)}" y="${r(pb.y)}" width="${r(pb.width)}" height="${r(pb.height)}"${rxAttr}${fillAttr}${strokeAttr}/>${bgImageMarkup}${renderPseudoBoxPerSideBorders(pb)}`);
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
    // DM-513: pseudos with `font-family: 'sdicon'` etc. need their icon font
    // routed through the renderer, not the parent element's body font.
    const segFontFamily = seg.fontFamily ?? fontFamily;
    // Honor either segment-level font-variant override (::first-line) or
    // the element-level font-variant-caps. (DM-294, DM-361, DM-444). See
    // resolveCapsFeatures (module scope) for the full spec mapping. Merge with
    // author-set `font-feature-settings` (DM-564) — e.g. Inter's `cv11`
    // single-story `a` alternate is set by next/font marketing pages.
    const segFfsFeatures = elementFontFeatures(el, segFontFamily);
    const segFeatures = mergeFeatureLists(
      mergeFeatureLists(
        mergeFeatureLists(
          resolveCapsFeatures(seg.fontVariant, el.styles.fontVariantCaps),
          resolveFontVariantFeatures(el.styles.fontVariantEastAsian, el.styles.fontVariantNumeric,
          el.styles.fontVariantLigatures, el.styles.letterSpacing, el.styles.textRendering,
          el.styles.fontKerning, el.styles.fontVariantPosition),
        ),
        segFfsFeatures,
      ),
      resolveChwsFeature(segFfsFeatures),
    );
    // Pass per-char xOffsets through (relative to seg.x) so multi-line wrapped
    // text anchors glyphs at the exact Chromium-measured positions.
    const xOffsetsRelRaw = seg.xOffsets != null ? seg.xOffsets.map((v) => v - seg.x) : undefined;
    const _segRaw = suppressGlyphChars(seg.text, seg);
    // DM-1055: locate this segment in the full paragraph and mirror its brackets
    // with the paragraph-level embedding levels (so a `(`…`)` split across wrapped
    // lines matches Chrome). Falls back to per-segment resolution when the element
    // has no RTL content.
    let reordered: { text: string; xOffsets?: number[] };
    if (_segFullLevels != null) {
      const _idx = el.text.indexOf(seg.text, _segBidiOffset);
      const _base = _idx >= 0 ? _idx : _segBidiOffset;
      reordered = applyBidiAt(_segRaw, xOffsetsRelRaw, _segFullLevels, _base);
      _segBidiOffset = _base + seg.text.length;
    } else {
      reordered = applyBidi(_segRaw, xOffsetsRelRaw, dir);
    }
    // DM-822: anisotropic correction — see `anisotropicCorrectionXOffsets`.
    const segXOffsets = anisotropicCorrectionXOffsets(el, reordered.xOffsets);
    const segAscent = seg.fontAscent ?? el.fontAscent;
    const result = renderTextAsPath(reordered.text, seg.x, seg.y, {
      fontSize: segFontSize, fontFamily: segFontFamily, fontWeight: segFontWeight, fill: segColor,
      xOffsets: segXOffsets, fontStyle: segFontStyle, ascentOverride: segAscent,
      features: segFeatures, lang: el.styles.lang, variationSettings: elVariationSettings,
      textStrokeWidth: _ts.width, textStrokeColor: _ts.color, paintOrder: _ts.paintOrder,
      dottedCircleMarks: seg.dottedCircleMarks,
      bidiOverride: bidiOverrideFor(el), fontStretch: el.styles.fontStretch,
      fontVariantEmoji: fontVariantEmojiOf(el.styles), fontSynthesis: fontSynthesisOf(el.styles),
    });
    segParts.push(result);
    // DM-1723/DM-1725: the element's own decoration plus every ancestor
    // decorating box's propagated entry paint independently (Blink's
    // AppliedTextDecorations accumulation). Decorations anchor on the
    // segment's fragment top + captured FloatAscent, unrounded — the paint
    // snap happens per line inside `emitDecorationLine`.
    const decoMarkup = renderAppliedTextDecorations(el, fillColor, {
      segX: seg.x, fragTop: seg.y, fontAscent: segAscent, fontDescent: el.fontDescent,
      segWidth: seg.width,
      fontSize: segFontSize, fontFamily: segFontFamily, fontWeight: segFontWeight,
      runText: reordered.text, features: segFeatures, runXOffsets: segXOffsets ?? undefined,
      idBase: `${clipId}-dec${_decoSegIdx++}`,
    });
    if (decoMarkup !== "") segParts.push(decoMarkup);
    // Per-char raster overlays (SK-1090). Emoji inline with path-rendered
    // text get their actual Chrome-painted pixels stamped over the position.
    const rasterOverlay = rasterGlyphOverlays(seg, segFontSize, clipId);
    if (rasterOverlay !== "") segParts.push(rasterOverlay);
    // DM-2367: the pseudo owns its whole atomic paint (box, glyphs,
    // decorations, and raster overlays). Apply its computed filter list before
    // transform and grouped opacity, matching Blink's paint-property nesting.
    if (seg.pseudoBox != null) {
      parts.push(wrapPseudoPaintEffects(seg.pseudoBox, segParts.join("")));
    } else {
      for (const sp of segParts) parts.push(sp);
    }
  }

  // Wrap the multi-segment output in the element's clip-path only when the
  // element actually overflow-clips (DM-305) — see comment in
  // renderSingleLineText for why an unconditional clip is wrong.
  if (opts.overflowClip) {
    return anisotropicCorrectionWrap(el, `<g clip-path="url(#${clipId})">${parts.join("\n")}</g>`);
  }
  return anisotropicCorrectionWrap(el, parts.join("\n"));
}

/**
 * Render multi-line text (pre blocks).
 */
export function renderMultiLineText(opts: RenderTextOpts): string {
  const _ts = textStrokeParams(opts.el.styles);
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
  const ffsFeatures = elementFontFeatures(el, fontFamily);
  const fvsAxes = opticalVariationSettings(el);
  if (el.textSegments != null && el.textSegments.length > 0) {
    const dir = el.styles.direction === "rtl" ? "rtl" : "ltr";
    for (const seg of el.textSegments) {
      const xOffsetsRelRaw = seg.xOffsets != null ? seg.xOffsets.map((v) => v - seg.x) : undefined;
      const reordered = applyBidi(suppressGlyphChars(seg.text, seg), xOffsetsRelRaw, dir);
      // DM-822: anisotropic correction — see `anisotropicCorrectionXOffsets`.
      const segXOffsets = anisotropicCorrectionXOffsets(el, reordered.xOffsets);
      const segFontSize = seg.fontSize ?? fontSize;
      const segFontWeight = seg.fontWeight ?? fontWeight;
      const segColor = seg.color ?? fillColor;
      const segAscent = seg.fontAscent ?? el.fontAscent;
      const result = renderTextAsPath(reordered.text, seg.x, seg.y, {
        fontSize: segFontSize, fontFamily, fontWeight: segFontWeight, fill: segColor,
        xOffsets: segXOffsets, fontStyle: el.styles.fontStyle, ascentOverride: segAscent,
        features: ffsFeatures, lang: el.styles.lang, variationSettings: fvsAxes,
        textStrokeWidth: _ts.width, textStrokeColor: _ts.color, paintOrder: _ts.paintOrder,
        dottedCircleMarks: seg.dottedCircleMarks,
        bidiOverride: bidiOverrideFor(el), fontStretch: el.styles.fontStretch,
        fontVariantEmoji: fontVariantEmojiOf(el.styles), fontSynthesis: fontSynthesisOf(el.styles),
      });
      parts.push(`  ${result}`);
    }
  } else {
    const lines = el.text.split("\n");
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      if (line === "") continue;
      const lineY = startY + li * lineHeight;
      const result = renderTextAsPath(line, startX, lineY, {
        fontSize, fontFamily, fontWeight, fill: fillColor,
        fontStyle: el.styles.fontStyle, ascentOverride: el.fontAscent,
        features: ffsFeatures, lang: el.styles.lang, variationSettings: fvsAxes,
        textStrokeWidth: _ts.width, textStrokeColor: _ts.color, paintOrder: _ts.paintOrder,
        bidiOverride: bidiOverrideFor(el), fontStretch: el.styles.fontStretch,
        fontVariantEmoji: fontVariantEmojiOf(el.styles), fontSynthesis: fontSynthesisOf(el.styles),
      });
      parts.push(`  ${result}`);
    }
  }
  parts.push("</g>");
  return anisotropicCorrectionWrap(el, parts.join("\n"));
}

/**
 * Render input/textarea text.
 */
export function renderInputText(opts: RenderTextOpts): string {
  const _ts = textStrokeParams(opts.el.styles);
  const { el, clipId, fillColor } = opts;
  // Compatibility for captured trees produced before textarea/vertical text
  // gained vector line/run geometry. Current captures never set this field.
  if (el.elementRaster != null && el.elementRaster.dataUri != null) {
    const er = el.elementRaster;
    // DM-924: snap raster <image> position to integer CSS pixels. The
    // screenshot inside is captured at integer pixel dimensions; emitting
    // at a fractional position (e.g. y=1621.44 for a textarea content
    // box) triggers the browser's image-resampling interpolation and the
    // text inside renders blurry. Snapping keeps the source PNG's
    // pixels 1:1 with the rendered canvas, preserving text sharpness.
    return `<image href="${er.dataUri}" x="${Math.round(er.x)}" y="${Math.round(er.y)}" width="${r(er.width)}" height="${r(er.height)}" preserveAspectRatio="none" clip-path="url(#${clipId})"/>`;
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
  // fontkit native advances when the probe wasn't run.
  const xOffsetsRel = el.inputXOffsets != null
    ? el.inputXOffsets.map((v) => v - textX) : undefined;
  const inputFeatures = elementFontFeatures(el, fontFamily);
  const inputAxes = opticalVariationSettings(el);
  // DM-991: textareas carry per-LINE textSegments captured via the wrap
  // probe in `walker/input-value.ts`. Iterate them so each visual line
  // becomes its own source-owned emission run at its own y, matching Chrome's
  // soft-wrap layout. Single-line `<input>` skips this branch (textSegments
  // is undefined for inputs — they only set `inputXOffsets`).
  if (el.textSegments != null && el.textSegments.length > 0) {
    const segParts: string[] = [];
    for (const seg of el.textSegments) {
      const segXOffsetsRel = seg.xOffsets != null ? seg.xOffsets.map((v) => v - seg.x) : undefined;
      const segResult = renderTextAsPath(seg.text, seg.x, seg.y, {
        fontSize, fontFamily, fontWeight: textFontWeight, fill: textColor,
        xOffsets: segXOffsetsRel, fontStyle: textFontStyle, ascentOverride: el.fontAscent,
        features: inputFeatures, lang: el.styles.lang, variationSettings: inputAxes,
        textStrokeWidth: _ts.width, textStrokeColor: _ts.color, paintOrder: _ts.paintOrder,
        bidiOverride: bidiOverrideFor(el), fontStretch: el.styles.fontStretch,
        fontVariantEmoji: fontVariantEmojiOf(el.styles), fontSynthesis: fontSynthesisOf(el.styles),
      });
      segParts.push(segResult);
    }
    if (segParts.length > 0) return anisotropicCorrectionWrap(el, `<g clip-path="url(#${clipId})">${segParts.join("")}</g>`);
  }
  const result = renderTextAsPath(el.text, textX, tt, {
    fontSize, fontFamily, fontWeight: textFontWeight, fill: textColor,
    xOffsets: xOffsetsRel, fontStyle: textFontStyle, ascentOverride: el.fontAscent,
    features: inputFeatures, lang: el.styles.lang, variationSettings: inputAxes,
    textStrokeWidth: _ts.width, textStrokeColor: _ts.color, paintOrder: _ts.paintOrder,
    bidiOverride: bidiOverrideFor(el), fontStretch: el.styles.fontStretch,
    fontVariantEmoji: fontVariantEmojiOf(el.styles),
  });
  // Clip the path-rendered text to the input's content rect so values that
  // overflow the visible width (common on readonly inputs with long text or
  // any input narrower than its value) are truncated like Chrome paints
  // them, not extending past the right border. DM-245.
  return anisotropicCorrectionWrap(el, `<g clip-path="url(#${clipId})">${result}</g>`);
}
