/**
 * Text Renderer
 *
 * Renders text in SVG using fontkit path outlines for cross-browser identical rendering.
 */

import bidiFactory from "bidi-js";
import { computeSkipInkGaps, getDecorationMetrics, renderTextAsPath } from "./text-to-path.js";
import type { CapturedElement, TextSegment } from "../capture/types.js";

// ── Rendering helpers ──

function r(n: number): string { return Number(n.toFixed(1)).toString(); }
function esc(s: string): string { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

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
 * DM-783: parse a resolved `transform-origin` string (`"50px 50px"`,
 * `"50px 50px 0px"`) into an `(ox, oy)` pair in px relative to the pseudoBox's
 * top-left. Chrome's getComputedStyle always returns px values (never
 * keywords like "left top" or "%"), so we just split + parseFloat. The
 * 3rd Z component is ignored — we only paint 2D. Falls back to the box
 * center when the value is missing or unparseable, matching Chrome's
 * `50% 50%` default.
 */
function parsePseudoTransformOrigin(originCss: string | undefined, width: number, height: number): { ox: number; oy: number } {
  const center = { ox: width / 2, oy: height / 2 };
  if (originCss == null || originCss === "") return center;
  const parts = originCss.split(/\s+/).map((p) => parseFloat(p));
  if (parts.length < 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) return center;
  return { ox: parts[0], oy: parts[1] };
}

/**
 * DM-783: when the pseudoBox carries a `transform`, wrap `inner` in a
 * `<g transform="…">` that pre-bakes the rotation/scale around the captured
 * `transform-origin` — `translate(tx,ty) <css-transform> translate(-tx,-ty)`
 * where `(tx, ty)` is the origin in viewport coords. SVG accepts the CSS
 * matrix() / rotate() / scale() / translate() / skew() forms unchanged
 * (column-major convention matches), so `pb.transform` pastes in verbatim.
 * Returns `inner` unwrapped when no transform was captured.
 */
function pseudoBoxTransformWrap(pb: NonNullable<TextSegment["pseudoBox"]>, inner: string): string {
  if (pb.transform == null || pb.transform === "" || pb.transform === "none") return inner;
  const { ox, oy } = parsePseudoTransformOrigin(pb.transformOrigin, pb.width, pb.height);
  const tx = pb.x + ox;
  const ty = pb.y + oy;
  return `<g transform="translate(${r(tx)} ${r(ty)}) ${pb.transform} translate(${r(-tx)} ${r(-ty)})">${inner}</g>`;
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
  const suppress = seg.rasterGlyphs.filter((g) => g.suppressGlyph === true);
  if (suppress.length === 0) return normalized;
  // text is a UTF-16 string; charIndex is a UTF-16 position. U+200B is one
  // UTF-16 unit so the substitution preserves text length and xOffsets
  // alignment.
  let out = "";
  for (let i = 0; i < normalized.length; i++) {
    const drop = suppress.some((g) => g.charIndex === i);
    out += drop ? ZWSP : normalized[i];
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
  /** CSS `text-decoration-thickness` (e.g. `5px` or `auto`). DM-431. */
  thicknessOverride?: string,
  /** CSS `text-underline-offset` (e.g. `6px` or `auto`). DM-431. */
  underlineOffset?: string,
  /** Run text used to compute `text-decoration-skip-ink: auto` glyph
   *  intercepts. Required for skip-ink to apply. DM-446. */
  runText?: string,
  /** CSS `text-decoration-skip-ink` — `auto` (default) or `none`. Only solid /
   *  double underlines honor it (matches Chromium). DM-446. */
  skipInk?: string,
  /** OpenType feature tags forwarded to fontkit shaping when computing skip-
   *  ink intercepts so small-caps / petite-caps glyphs match the painted text. */
  features?: string[],
): string {
  if (textDecorationLine == null || textDecorationLine === "none" || textDecorationLine === "") return "";
  const m = getDecorationMetrics(fontFamily, fontSize, fontWeight, fontStyle, thicknessOverride, underlineOffset);
  const lines: string[] = [];
  const has = (k: string) => textDecorationLine.includes(k);
  const dash = (thick: number) => style === "dashed" ? ` stroke-dasharray="${thick * 2} ${thick * 2}"`
    : style === "dotted" ? ` stroke-dasharray="${thick} ${thick}"` : "";
  // Skip-ink applies to solid + double + wavy underlines per Chromium's
  // current behaviour (`decoration_line_painter.cc::Paint`; verified against
  // Chrome's painted output for the 20-deep-wavy-underline-descenders
  // fixture — DM-814). Dashed / dotted still short-circuit. We compute gaps
  // once if any underline emit needs them.
  const skipInkActive = (skipInk == null || skipInk === "auto") && runText != null && runText !== ""
    && (style == null || style === "solid" || style === "double" || style === "wavy" || style === "");
  // Compute X-range gaps where the underline rect crosses glyph ink. Returned
  // gaps are run-relative (0 = segX); subSegments() splits the underline span
  // around them.
  function computeGapsAt(yRel: number, thick: number): Array<[number, number]> {
    if (!skipInkActive || runText == null) return [];
    return computeSkipInkGaps(runText, fontSize, fontFamily, fontWeight, fontStyle, yRel, thick, features, segWidth);
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
  // Emit one decoration line at (y, thickness) honoring the text-decoration-style.
  // (DM-345.) For wavy: build a sin-wave path. For double: two parallel
  // lines with a 1×thickness gap. For solid/dashed/dotted: a single
  // <line> with optional stroke-dasharray.
  const explicitThickness = thicknessOverride != null && thicknessOverride !== ""
    && thicknessOverride !== "auto" && thicknessOverride !== "from-font";
  function emitLine(y: number, t: number, isUnderline: boolean = false): string {
    if (style === "wavy") {
      // Match Chromium's `decoration_line_painter.cc::MakeWave` + `WavyPath`:
      //   wavelength = 1 + 2 * round(2 * thickness + 0.5)
      //   cp_distance = 0.5 + round(3 * thickness + 0.5)
      // Each wavelength is one cubic Bezier with both control points at
      // `wavelength/2` x — `cp1.y = +cp_distance`, `cp2.y = -cp_distance` —
      // producing an S-curve from `(0, 0)` through a peak / trough back to
      // `(wavelength, 0)`. Total visual amplitude ≈ `cp_distance * 0.289`.
      //
      // Earlier we rendered as quadratic Q curves with the control point at
      // `±cp_distance` directly; that paints visual amplitude `cp_distance/2`
      // — about 70% taller than Chrome — making 18 px wavy underlines look
      // exaggerated. Switch to cubic to reproduce Chrome's geometry. (DM-446.)
      //
      // Thickness uses Chromium's auto-rule `max(1, fontSize/10)` rather than
      // `getDecorationMetrics`'s `fontSize/20` empirical formula. The
      // empirical rule compensates for an SVG-vs-HTML pixel-grid mismatch on
      // axis-aligned solid strokes; curves don't hit that artifact, and the
      // smaller value paints a visibly thinner stroke than Chrome.
      const tc = explicitThickness ? Math.max(1, t) : Math.max(1, fontSize / 10);
      const wavelength = 1 + 2 * Math.round(2 * tc + 0.5);
      const cpDist = 0.5 + Math.round(3 * tc + 0.5);
      // DM-830: re-probed against native Chromium (`tools/probe-wavy-geom5.mjs`)
      // at fs={12, 16, 24, 36} × thickness={1, 2, 3, 4, 6}, measuring wave
      // centre-y and peak amplitude against the descender-less 'm' baseline.
      // Two findings differed from the earlier DM-446 calibration:
      //
      //  (1) Chrome paints amplitude `~0.278 × cpDist` (was 0.289). Across the
      //      sample matrix: t=1→1.25, t=2→2.00, t=3→3.00, t=4→3.75, t=6→5.50
      //      — Chrome's `cpDist`-to-amplitude ratio is consistently 0.27-0.28,
      //      NOT the cubic-Bezier-geometric 0.289 = √3/(2π/n) factor we'd
      //      derived analytically. Either Chrome uses a different
      //      bezier-flatness setting or its wavy is actually a different
      //      curve family at the painted scale.
      //
      //  (2) Wave centre-y is INDEPENDENT of fontSize (the previous formula
      //      `y + 2 * amplitude` produced wave-y identical across font sizes
      //      because `y = baseline + 1.5×t` itself was thickness-only; the
      //      empirical pattern just confirms this). Centre-y DOES depend on
      //      thickness: yCenter - baseline ≈ 2 + t/2 + amplitude. This is
      //      consistent with "the wave's TOP edge sits exactly at the solid-
      //      underline BOTTOM edge, leaving descender region clear" — where
      //      Chrome's auto solid underline at thickness `t` paints at
      //      baseline + 2 - t/2 to baseline + 2 + t/2.
      //
      // `y` passed into `emitLine` already equals `baseline + 1.5×t + extra`
      // (the extra is the author's text-underline-offset). The new formula
      // `yWave = y + amp + 2 - t` algebraically reduces to
      // `baseline + 2 + 0.5×t + amp + extra`, matching the probed wave centre.
      // For uniform text-underline-offset = 0, errors stay ≤ 0.4 px across
      // the probed thickness range.
      const waveAmplitude = 0.278 * cpDist;
      const yWave = y + waveAmplitude + 2 - tc;
      // DM-814: skip-ink for wavy. Compute gaps using the wave's full
      // vertical extent (2*amplitude + stroke thickness) so a descender that
      // pokes into the wave's PEAK or TROUGH zones breaks the wave, not just
      // descenders that cross the centerline. Then emit one wave path per
      // non-gap sub-segment. Each sub-segment's wave starts at phase 0 at
      // its own x0 — adjacent segments aren't strictly phase-coherent with a
      // hypothetical continuous wave, but the descender gap is usually wider
      // than the discontinuity which makes the visual indistinguishable from
      // Chrome's per-glyph break style.
      const bandThickness = 2 * waveAmplitude + tc;
      const wavyGaps = isUnderline ? computeGapsAt(yWave - baselineY, bandThickness) : [];
      const subs = subSegments(wavyGaps);
      const parts: string[] = [];
      for (const { x0: sx0, x1: sx1 } of subs) {
        if (sx1 - sx0 < 0.5) continue;
        let d = `M ${r(sx0)} ${r(yWave)}`;
        let x = sx0;
        while (x < sx1) {
          const nx = Math.min(x + wavelength, sx1);
          const cpX = x + wavelength / 2;
          d += ` C ${r(cpX)} ${r(yWave + cpDist)} ${r(cpX)} ${r(yWave - cpDist)} ${r(nx)} ${r(yWave)}`;
          x = nx;
        }
        parts.push(`<path d="${d}" fill="none" stroke="${decorationColor}" stroke-width="${r(tc)}"/>`);
      }
      return parts.join("");
    }
    if (style === "double") {
      // Double: two parallel lines. Per Chromium's `decoration_line_painter
      // .cc::DrawLineAsRect`, kDouble extends the single-underline rect to
      // 3×thickness tall and emits a stroke at each end — i.e., the TOP
      // stroke sits at the single-underline position and the BOTTOM stroke
      // sits 2×thickness below it. Total height = 3×thickness.
      //
      // Earlier we centered the double on the single-underline position,
      // which placed the top of the top stroke AT the baseline. The skip-ink
      // intercept band then began at y_rel=0 and false-triggered on every
      // baseline-resting glyph (d / o / u / b / l / e ...) producing the
      // shredded-line artifact reported in DM-446.
      const stroke = Math.max(1, t);
      const top = y;
      const bot = y + 2 * stroke;
      // Skip-ink band spans both strokes plus their stroke widths:
      // [top - stroke/2, bot + stroke/2] = 3×stroke tall, centered at
      // (top + bot) / 2.
      const bandCenter = (top + bot) / 2;
      const bandThickness = (bot - top) + stroke;
      const dblGaps = isUnderline
        ? computeGapsAt(bandCenter - baselineY, bandThickness)
        : [];
      const subs = subSegments(dblGaps);
      return subs.map(({ x0, x1 }) =>
        `<line x1="${r(x0)}" y1="${r(top)}" x2="${r(x1)}" y2="${r(top)}" stroke="${decorationColor}" stroke-width="${r(stroke)}"/>`
        + `<line x1="${r(x0)}" y1="${r(bot)}" x2="${r(x1)}" y2="${r(bot)}" stroke="${decorationColor}" stroke-width="${r(stroke)}"/>`
      ).join("");
    }
    // Solid (or dashed / dotted): single line span with optional dasharray.
    // Skip-ink applies only to solid (Chromium short-circuits dashed / dotted).
    const wantSkip = isUnderline && (style == null || style === "solid" || style === "");
    const solidGaps = wantSkip ? computeGapsAt(y - baselineY, t) : [];
    const subs = subSegments(solidGaps);
    return subs.map(({ x0, x1 }) =>
      `<line x1="${r(x0)}" y1="${r(y)}" x2="${r(x1)}" y2="${r(y)}" stroke="${decorationColor}" stroke-width="${r(t)}"${dash(t)}/>`
    ).join("");
  }
  if (has("underline")) {
    lines.push(emitLine(baselineY + m.underlineOffsetY, m.underlineThickness, true));
  }
  if (has("line-through")) {
    lines.push(emitLine(baselineY - m.strikeoutOffsetY, m.strikeoutThickness));
  }
  if (has("overline")) {
    lines.push(emitLine(baselineY - m.overlineOffsetY, m.overlineThickness));
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
  /** DM-782: emit the pseudoBox's `background-image` (gradient / url() layers)
   *  as SVG paint server defs + a covering `<rect>` per layer. Returned
   *  markup is the rect string(s), inserted BEFORE the glyph emit so the
   *  gradient paints under the text. Caller (main render loop) owns
   *  `defsParts` / `clipIdx` and provides this closure; standalone callers
   *  (unit tests) pass undefined and the gradient layers are skipped. */
  emitPseudoBoxBgLayers?: (pb: { x: number; y: number; width: number; height: number; backgroundImage: string; borderRadius?: number }) => string;
}

/**
 * Returns true when every codepoint in `text` is in a Unicode Private Use
 * Area (U+E000–F8FF, U+F0000–FFFFD, U+100000–10FFFD). Used to suppress the
 * `<text>` fallback for icon-font codepoints whose path-mode emission was
 * already suppressed as notdef tofu — letting Chromium repaint the tofu
 * via its UA glyph fallback would defeat the suppression. (DM-490 / DM-500.)
 */
function isAllPrivateUseArea(text: string): boolean {
  if (text.length === 0) return false;
  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i)!;
    const inPua = (cp >= 0xE000 && cp <= 0xF8FF)
      || (cp >= 0xF0000 && cp <= 0xFFFFD)
      || (cp >= 0x100000 && cp <= 0x10FFFD);
    if (!inPua) return false;
    i += cp > 0xFFFF ? 2 : 1;
  }
  return true;
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
//   Default value when omitted is 1 (enabled). 0 / `off` means disabled —
//   omit from the list so fontkit's defaults / other enables aren't shadowed.
export function parseFontFeatureSettings(css: string | undefined): string[] | undefined {
  if (css == null || css === "" || css === "normal") return undefined;
  const out: string[] = [];
  // Match `"tag"` or `'tag'` optionally followed by integer/on/off.
  const re = /["']([a-zA-Z0-9]{4})["']\s*(\d+|on|off)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) != null) {
    const tag = m[1];
    const value = m[2];
    const enabled = value == null || value === "on" || (value !== "off" && parseInt(value, 10) !== 0);
    if (enabled) out.push(tag);
  }
  return out.length > 0 ? out : undefined;
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

function mergeFeatureLists(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
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
    return `<image href="${ssSeg.rasterDataUri}" x="${r(rr.x)}" y="${r(rr.y)}" width="${r(rr.width)}" height="${r(rr.height)}" preserveAspectRatio="none" clip-path="url(#${clipId})"/>`;
  }
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
  const pathTextRawSrc = singleSeg != null ? singleSeg.text : el.text;
  const pathTextRaw = suppressGlyphChars(pathTextRawSrc, singleSeg);
  const xOffsetsRelRaw = singleSeg?.xOffsets != null ? singleSeg.xOffsets.map((v) => v - tl) : undefined;
  const dir = el.styles.direction === "rtl" ? "rtl" : "ltr";
  const reordered = applyBidi(pathTextRaw, xOffsetsRelRaw, dir);
  const pathText = reordered.text;
  // DM-822: pre-divide xOffsetsRel by cx when an anisotropic correction
  // wrap will multiply positions on emit. No-op for uniform-scale text.
  const xOffsetsRel = anisotropicCorrectionXOffsets(el, reordered.xOffsets);
  const features = mergeFeatureLists(
    resolveCapsFeatures(singleSeg?.fontVariant, el.styles.fontVariantCaps),
    parseFontFeatureSettings(el.styles.fontFeatureSettings),
  );
  const variationSettings = parseFontVariationSettings(el.styles.fontVariationSettings);
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
  const singleSegBoxMarkup = (singleSeg?.pseudoBox != null) ? (() => {
    const pb = singleSeg.pseudoBox!;
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
    const bgImageMarkup = (pb.backgroundImage != null && pb.backgroundImage !== "none" && pb.backgroundImage !== "" && opts.emitPseudoBoxBgLayers != null)
      ? opts.emitPseudoBoxBgLayers({ x: pb.x, y: pb.y, width: pb.width, height: pb.height, backgroundImage: pb.backgroundImage, borderRadius: clampedBR > 0 ? clampedBR : undefined })
      : "";
    return `<rect x="${r(pb.x)}" y="${r(pb.y)}" width="${r(pb.width)}" height="${r(pb.height)}"${rxAttr}${fillAttr}${strokeAttr}/>${bgImageMarkup}${renderPseudoBoxPerSideBorders(pb)}`;
  })() : "";
  const result = renderTextAsPath(pathText, tl, tt, segFontSize, segFontFamily, segFontWeight, segColor, undefined, el.textWidth, xOffsetsRel, segFontStyle, segAscent, features, el.styles.lang, variationSettings, _ts.width, _ts.color, _ts.paintOrder);
  if (result != null) {
    const decoColor = (el.styles.textDecorationColor && el.styles.textDecorationColor !== "currentcolor")
      ? el.styles.textDecorationColor : segColor;
    // baselineY = textTop + fontAscent. Using fontSize here would put the
    // underline ~1px too low (fontSize includes descent; baseline sits at
    // ascent above textTop, not at the line-bottom). DM-265.
    // Round to integer px so Chrome's pixel-aligned decoration paint
    // (`round(baseline) + thickness` for underline top) reproduces. DM-398.
    const decoBaselineY = Math.round(tt + (segAscent ?? segFontSize));
    const decoMarkup = renderTextDecoration(el.styles.textDecorationLine, decoColor, el.styles.textDecorationStyle, tl, decoBaselineY, el.textWidth ?? 0, segFontSize, segFontFamily, segFontWeight, el.styles.fontStyle, el.styles.textDecorationThickness, el.styles.textUnderlineOffset, pathText, el.styles.textDecorationSkipInk, features);
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
    const inner = `${singleSegBoxMarkup}${result}${decoMarkup}${rasterOverlay}`;
    const transformed = (singleSeg?.pseudoBox != null) ? pseudoBoxTransformWrap(singleSeg.pseudoBox, inner) : inner;
    if (opts.overflowClip) {
      return anisotropicCorrectionWrap(el, `<g clip-path="url(#${clipId})">${transformed}</g>`);
    }
    return anisotropicCorrectionWrap(el, transformed);
  }

  // DM-490 / DM-500: when the text is entirely Private Use Area codepoints
  // and the path-mode renderer returned null (no glyph emitted because every
  // glyph was a notdef tofu we suppressed), don't fall through to a `<text>`
  // element either — Chromium will paint the same notdef tofu using its own
  // glyph fallback, which is exactly what we suppressed at the path level.
  // A missing icon should read as 'nothing'.
  if (isAllPrivateUseArea(el.text)) return "";

  // Fallback to CSS <text> if path rendering fails
  const ff = segFontFamily.replace(/"/g, "'");
  const lsCss = el.styles.letterSpacing !== "normal" && el.styles.letterSpacing !== "0px"
    ? `letter-spacing:${el.styles.letterSpacing};` : "";
  const baseStyle = `font-family:${ff};font-size:${r(segFontSize)}px;font-weight:${segFontWeight};font-kerning:normal;font-optical-sizing:auto;${lsCss}`;

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
  const _ts = textStrokeParams(opts.el.styles);
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
  const elVariationSettings = parseFontVariationSettings(el.styles.fontVariationSettings);
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
    const segFeatures = mergeFeatureLists(
      resolveCapsFeatures(seg.fontVariant, el.styles.fontVariantCaps),
      parseFontFeatureSettings(el.styles.fontFeatureSettings),
    );
    // Pass per-char xOffsets through (relative to seg.x) so multi-line wrapped
    // text anchors glyphs at the exact Chromium-measured positions.
    const xOffsetsRelRaw = seg.xOffsets != null ? seg.xOffsets.map((v) => v - seg.x) : undefined;
    const reordered = applyBidi(suppressGlyphChars(seg.text, seg), xOffsetsRelRaw, dir);
    // DM-822: anisotropic correction — see `anisotropicCorrectionXOffsets`.
    const segXOffsets = anisotropicCorrectionXOffsets(el, reordered.xOffsets);
    const segAscent = seg.fontAscent ?? el.fontAscent;
    const result = renderTextAsPath(reordered.text, seg.x, seg.y, segFontSize, segFontFamily, segFontWeight, segColor, undefined, undefined, segXOffsets, segFontStyle, segAscent, segFeatures, el.styles.lang, elVariationSettings, _ts.width, _ts.color, _ts.paintOrder);
    if (result != null) { segParts.push(result); }
    else if (!isAllPrivateUseArea(seg.text) && reordered.text.replace(/[\s​]/g, "") !== "") {
      // Fallback to CSS <text> if path rendering fails. DM-490 / DM-500: when
      // the segment text is entirely Private Use Area (icon-font codepoints
      // we couldn't resolve to a real glyph), suppress the <text> fallback
      // too — Chromium's UA fallback paints the same notdef tofu we already
      // suppressed at the path level, defeating the point.
      // DM-779: same logic for `::first-letter` drop caps — when every glyph
      // in the segment was a `suppressGlyph` rasterGlyph target (e.g. the
      // floated drop-cap letter sitting on its own line), `reordered.text`
      // collapses to all-ZWSP and the raster overlay paints the visible
      // glyph; emitting `seg.text` in the `<text>` fallback would paint a
      // duplicate body-size copy of the letter behind the raster.
      const ff = segFontFamily.replace(/"/g, "'");
      const baseStyle = `font-family:${ff};font-size:${r(segFontSize)}px;font-weight:${segFontWeight};font-kerning:normal;font-optical-sizing:auto;`;
      const sy = seg.y + seg.height / 2;
      segParts.push(`<text x="${r(seg.x)}" y="${r(sy)}" dominant-baseline="central" fill="${segColor}" style="${baseStyle}" clip-path="url(#${clipId})">${esc(seg.text)}</text>`);
    }
    const segDecoBaselineY = Math.round(seg.y + (segAscent ?? segFontSize));
    const decoMarkup = renderTextDecoration(decoLine, decoColor, decoStyle, seg.x, segDecoBaselineY, seg.width, segFontSize, segFontFamily, segFontWeight, el.styles.fontStyle, el.styles.textDecorationThickness, el.styles.textUnderlineOffset, reordered.text, el.styles.textDecorationSkipInk, segFeatures);
    if (decoMarkup !== "") segParts.push(decoMarkup);
    // Per-char raster overlays (SK-1090). Emoji inline with path-rendered
    // text get their actual Chrome-painted pixels stamped over the position.
    const rasterOverlay = rasterGlyphOverlays(seg, segFontSize, clipId);
    if (rasterOverlay !== "") segParts.push(rasterOverlay);
    // DM-783: when the segment's pseudo carries a CSS transform, wrap the
    // accumulated box + glyphs + decoration + raster overlay so all four
    // rotate together around the captured transform-origin. No-op for non-
    // pseudo segments (`seg.pseudoBox == null`) and for pseudos without a
    // transform — both flush through unchanged.
    if (seg.pseudoBox != null && seg.pseudoBox.transform != null && seg.pseudoBox.transform !== "" && seg.pseudoBox.transform !== "none") {
      parts.push(pseudoBoxTransformWrap(seg.pseudoBox, segParts.join("")));
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
  const ffsFeatures = parseFontFeatureSettings(el.styles.fontFeatureSettings);
  const fvsAxes = parseFontVariationSettings(el.styles.fontVariationSettings);
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
      const result = renderTextAsPath(reordered.text, seg.x, seg.y, segFontSize, fontFamily, segFontWeight, segColor, undefined, undefined, segXOffsets, el.styles.fontStyle, segAscent, ffsFeatures, el.styles.lang, fvsAxes, _ts.width, _ts.color, _ts.paintOrder);
      if (result != null) parts.push(`  ${result}`);
    }
  } else {
    const lines = el.text.split("\n");
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      if (line === "") continue;
      const lineY = startY + li * lineHeight;
      const result = renderTextAsPath(line, startX, lineY, fontSize, fontFamily, fontWeight, fillColor, undefined, undefined, undefined, el.styles.fontStyle, el.fontAscent, ffsFeatures, el.styles.lang, fvsAxes, _ts.width, _ts.color, _ts.paintOrder);
      if (result != null) parts.push(`  ${result}`);
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
  const inputFeatures = parseFontFeatureSettings(el.styles.fontFeatureSettings);
  const inputAxes = parseFontVariationSettings(el.styles.fontVariationSettings);
  const result = renderTextAsPath(el.text, textX, tt, fontSize, fontFamily, textFontWeight, textColor, undefined, undefined, xOffsetsRel, textFontStyle, el.fontAscent, inputFeatures, el.styles.lang, inputAxes, _ts.width, _ts.color, _ts.paintOrder);
  // Clip the path-rendered text to the input's content rect so values that
  // overflow the visible width (common on readonly inputs with long text or
  // any input narrower than its value) are truncated like Chrome paints
  // them, not extending past the right border. DM-245.
  if (result != null) return anisotropicCorrectionWrap(el, `<g clip-path="url(#${clipId})">${result}</g>`);

  // Fallback to CSS <text> if path rendering fails
  const textY = (el.textTop != null && el.textHeight != null && el.textHeight > 0)
    ? el.textTop + el.textHeight / 2 : el.y + el.height / 2;
  const ff = fontFamily.replace(/"/g, "'");
  const baseStyle = `font-family:${ff};font-size:${r(fontSize)}px;font-weight:${fontWeight};font-kerning:normal;font-optical-sizing:auto;`;

  return anisotropicCorrectionWrap(el, `<text x="${r(textX)}" y="${r(textY)}" dominant-baseline="central" fill="${textColor}" style="${baseStyle}" clip-path="url(#${clipId})">${esc(el.text)}</text>`);
}
