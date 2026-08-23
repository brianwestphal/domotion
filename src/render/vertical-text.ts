/**
 * DM-990 / DM-996: vertical writing-mode text renderer.
 *
 * Emits per-column SVG markup for `writing-mode: vertical-rl` /
 * `vertical-lr` / `sideways-rl` / `sideways-lr` elements. Each captured
 * `TextSegment` represents ONE column of chars (grouped by matching
 * `x` ±1 px at capture time); within each segment, `text[i]` is the
 * char at `yOffsets[i]` with orientation `verticalOrientations[i]`.
 *
 * Per-char emission:
 *   - upright  → render the char at its natural horizontal layout with
 *                  baseline at `charY + ascent` (so the glyph's top
 *                  aligns with Chrome's painted top of the char box).
 *                  Centered horizontally in the column.
 *   - rotated  → paint at Blink's line-relative text origin, then apply
 *                  `LineRelativeRect::ComputeRelativeToPhysicalTransform`
 *                  for the captured physical character box. The clockwise
 *                  modes and counter-clockwise `sideways-lr` therefore use
 *                  the same coordinate handoff as Blink's text painter.
 *
 * `Range.height` per char (captured as `verticalAdvances[i]`) is the
 * char's advance along the column axis. For upright CJK chars this is
 * ~font-size. For rotated Latin chars this is the char's natural
 * horizontal advance (the char's pre-rotation width = post-rotation
 * vertical advance).
 */

import type { CapturedElement, TextSegment } from "../capture/types.js";
import { measureEmphasisMarkMetrics, renderTextAsPath } from "./text-to-path.js";
import {
  capturedSegmentFontFamily, capturedTextSegmentFontFeatures, decorationLengthScale, emphasisGraphemeSpans,
  parseFontVariationSettings, parseTextEmphasisMark, renderTextDecoration,
} from "./text.js";
import { localeToScriptCodeForFontSelection } from "./generic-script-families.js";
import { esc } from "./format.js";

/**
 * DM-1054: text-emphasis marks for vertical writing-mode. The horizontal
 * `renderTextEmphasisMarks` (text.ts) lays marks along the x-axis above/below
 * the baseline and is only reached from `renderSingleLineText` — vertical text
 * dispatches to `renderVerticalSegments`, so its emphasis marks were dropped
 * entirely. In vertical modes the marks sit in a column BESIDE the text: on the
 * right for the default `over right` (the "over" edge rotates to the right in
 * vertical-rl / vertical-lr / sideways-rl). Marks use the same line-relative
 * font-metric offset and grapheme iteration as Blink, then the same writing-
 * mode transform as their text fragment.
 */
export function renderVerticalEmphasisMarks(el: CapturedElement, fillColor: string): string {
  const mark = parseTextEmphasisMark(el.styles.textEmphasisStyle);
  if (mark == null || el.textSegments == null) return "";
  const fontSize = parseFloat(el.styles.fontSize) || 14;
  const color = (el.styles.textEmphasisColor != null && el.styles.textEmphasisColor !== ""
    && el.styles.textEmphasisColor !== "currentcolor")
    ? el.styles.textEmphasisColor
    : (el.styles.color ?? fillColor);
  const out: string[] = [];
  for (const seg of el.textSegments) {
    if (seg.verticalWritingMode == null) continue;
    const yOffsets = seg.yOffsets;
    const advances = seg.verticalAdvances;
    if (yOffsets == null || advances == null) continue;
    const segFs = seg.fontSize ?? fontSize;
    const segAscent = seg.fontAscent ?? el.fontAscent ?? segFs * 0.8;
    const segDescent = el.fontDescent ?? Math.max(0, segFs - segAscent);
    const segFamily = capturedSegmentFontFamily(el, seg);
    const segWeight = seg.fontWeight ?? el.styles.fontWeight;
    const segStyle = seg.fontStyle ?? el.styles.fontStyle;
    const metrics = measureEmphasisMarkMetrics(mark, {
      fontSize: segFs, fontFamily: segFamily, fontWeight: segWeight,
      fontStyle: segStyle, fontStretch: el.styles.fontStretch, lang: el.styles.lang,
    });
    if (metrics == null) continue;
    const position = el.styles.textEmphasisPosition ?? "over right";
    const ccw = seg.verticalWritingMode === "sideways-lr";
    const under = /\bleft\b/.test(position) ? !ccw
      : /\bright\b/.test(position) ? ccw
        : /\bunder\b/.test(position);
    const offset = under
      ? Math.ceil(segDescent + metrics.ascent)
      : Math.floor(-segAscent - metrics.descent);
    const spans = emphasisGraphemeSpans(seg.text);
    for (const span of spans) {
      if (/^[\p{White_Space}\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(span.text)) continue;
      const charY = yOffsets[span.start] ?? seg.y;
      const charH = advances[span.start] ?? segFs;
      const lineRelativeX = seg.x + charH / 2;
      const lineRelativeBaseline = charY + segAscent + offset;
      const styleAttr = segStyle != null && segStyle !== "normal"
        ? ` font-style="${esc(segStyle)}"` : "";
      const inner = `<text x="${r(lineRelativeX - metrics.inkCenterX)}" y="${r(lineRelativeBaseline)}" font-family="${esc(segFamily)}" font-size="${r(metrics.fontSize)}" font-weight="${esc(String(segWeight))}"${styleAttr} fill="${esc(color)}">${esc(mark)}</text>`;
      const transform = lineRelativeToPhysicalTransform(
        seg.x, charY, seg.width, charH, seg.verticalWritingMode,
      );
      out.push(`<g transform="${transform}">${inner}</g>`);
    }
  }
  return out.join("");
}

function r(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

/**
 * Blink `LineRelativeRect::ComputeRelativeToPhysicalTransform`, transcribed.
 *
 * `physicalWidth` is the line-relative block size and `physicalHeight` is the
 * inline size after `CreateFromLineBox` swaps the dimensions of a vertical
 * physical box. Blink deliberately reuses the physical top-left as the
 * line-relative origin; these are not inverse-mapped DOM coordinates.
 */
export function lineRelativeToPhysicalTransform(
  x: number,
  y: number,
  physicalWidth: number,
  physicalHeight: number,
  writingMode: string,
): string {
  if (writingMode === "sideways-lr") {
    return `matrix(0 -1 1 0 ${r(x - y)} ${r(x + y + physicalHeight)})`;
  }
  return `matrix(0 1 -1 0 ${r(x + y + physicalWidth)} ${r(y - x)})`;
}

// DM-1122: CJK punctuation that the OpenType `vert` feature substitutes for a
// vertical-form glyph in vertical writing modes. Chrome enables `vert` for every
// upright glyph in a vertical run; the only glyphs it actually changes are these
// punctuation marks, whose ink moves from the horizontal cell corner to the
// vertical one (e.g. Hiragino's 。 ink goes from bottom-left [55,-65,355,235] to
// top-right [645,525,945,825] em-units). Ideographs and kana have no `vert`
// substitution, so they render identically with or without the feature. For the
// substituted glyphs the full em advance is what fills the column cell, so we
// anchor the em box to the column instead of ink-centering (which would shove a
// corner-set glyph toward the column's middle). The set is the CJK Symbols &
// Punctuation marks + their fullwidth-forms counterparts that carry `vert`
// glyphs in CoreText/DirectWrite/fontconfig CJK fonts: comma / period / the
// bracket and quote pairs.
const VERTICAL_FORM_PUNCTUATION = new Set<number>([
  0x3001, 0x3002, // 、 。
  0x3008, 0x3009, 0x300A, 0x300B, // 〈〉《》
  0x300C, 0x300D, 0x300E, 0x300F, // 「」『』
  0x3010, 0x3011, // 【】
  0x3014, 0x3015, 0x3016, 0x3017, 0x3018, 0x3019, 0x301A, 0x301B, // 〔〕〖〗〘〙〚〛
  0x301D, 0x301E, 0x301F, // 〝〞〟
  0xFF01, 0xFF08, 0xFF09, 0xFF0C, 0xFF0E, 0xFF1A, 0xFF1B, 0xFF1F, // ！（），．：；？
  0xFF3B, 0xFF3D, 0xFF5B, 0xFF5D, // ［］｛｝
]);

function hasVerticalFormPunctuation(ch: string): boolean {
  return ch.length >= 1 && VERTICAL_FORM_PUNCTUATION.has(ch.codePointAt(0)!);
}

export interface VerticalDecorationResolution {
  baselineType: "alphabetic" | "central";
  /** Position passed to the shared Blink offset transcription after vertical
   *  side resolution. An over-side central result is represented by `flip`. */
  underlinePosition: "auto" | "from-font" | "under";
  flipUnderlineAndOverline: boolean;
  localeScript: string;
}

/**
 * Blink `ResolveUnderlinePosition`, including its central-baseline locale
 * branch (`text_decoration_info.cc:23-53`, pinned rev 7d859f27).
 *
 * `FontDescription::GetScript()` is derived from the element locale, not from
 * the run's characters. Thus a Latin glyph under `lang=ja` takes the Japanese
 * side rule, while a kana glyph under `lang=en` takes the Latin rule. Sideways
 * writing modes are horizontal typographic modes and remain alphabetic.
 */
export function resolveVerticalDecoration(
  writingMode: string,
  textOrientation: string | undefined,
  underlinePositionCss: string | undefined,
  lang: string | undefined,
): VerticalDecorationResolution {
  const tokens = (underlinePositionCss ?? "auto").trim().toLowerCase().split(/\s+/);
  const localeScript = localeToScriptCodeForFontSelection(lang ?? "");
  const central = (writingMode === "vertical-rl" || writingMode === "vertical-lr")
    && textOrientation !== "sideways";
  if (!central) {
    return {
      baselineType: "alphabetic",
      underlinePosition: tokens.includes("under") ? "under"
        : tokens.includes("from-font") ? "from-font" : "auto",
      flipUnderlineAndOverline: false,
      localeScript,
    };
  }
  const kanaOrHangul = localeScript === "KATAKANA_OR_HIRAGANA" || localeScript === "HANGUL";
  const over = kanaOrHangul ? !tokens.includes("left") : tokens.includes("right");
  return {
    baselineType: "central",
    // ResolveDecorationAt changes an over-side result to kUnder before it
    // swaps the line bits; both central outcomes therefore feed the shared
    // metric engine's under branch.
    underlinePosition: "under",
    flipUnderlineAndOverline: over,
    localeScript,
  };
}

/** Upright vertical blobs never contribute decoration intercepts in Blink,
 * even for a skip-ink mode that otherwise asks for them. Preserve UTF-16
 * indexing while replacing those glyphs with zero-ink, zero-width controls;
 * rotated glyphs retain the captured y offsets as line-relative x anchors. */
export function verticalDecorationSkipInkText(seg: TextSegment): string | undefined {
  if (seg.verticalCombineUpright) return undefined;
  const orientations = seg.verticalOrientations;
  if (orientations == null) return seg.text;
  let out = "";
  for (let i = 0; i < seg.text.length;) {
    const cp = seg.text.codePointAt(i)!;
    const step = cp > 0xFFFF ? 2 : 1;
    const ch = seg.text.slice(i, i + step);
    out += orientations[i] === "upright" ? "\u200B".repeat(step) : ch;
    i += step;
  }
  return out;
}

function verticalDecorationIdBase(el: CapturedElement, seg: TextSegment): string {
  const key = [seg.text, seg.x, seg.y, seg.width, seg.height, seg.verticalWritingMode,
    el.styles.lang, el.styles.textDecorationLine, el.styles.textDecorationStyle,
    el.styles.textDecorationThickness, el.styles.textUnderlineOffset,
    el.styles.textUnderlinePosition, el.styles.textDecorationSkipInk,
    JSON.stringify(el.propagatedDecorations ?? [])].join("|");
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `vdec-${(hash >>> 0).toString(16)}`;
}

/**
 * DM-2514: emit Blink text-decoration geometry in LINE-RELATIVE space, then
 * hand it to the same physical transform as vertical glyphs. Thickness,
 * offsets, styles, snapping, double/wavy geometry, and skip-ink all come from
 * the shared horizontal source transcription rather than column-edge values.
 */
function renderVerticalDecoration(
  el: CapturedElement,
  seg: TextSegment,
  fillColor: string,
): string {
  const applied = [
    ...(el.propagatedDecorations ?? []).map((pd) => ({
      line: pd.line,
      color: pd.color ?? fillColor,
      style: pd.style,
      thickness: pd.thickness,
      underlineOffset: pd.underlineOffset,
      lengthScale: pd.lengthScale ?? 1,
    })),
    ...((el.styles.textDecorationLine != null && el.styles.textDecorationLine !== ""
      && el.styles.textDecorationLine !== "none") ? [{
        line: el.styles.textDecorationLine,
        color: (el.styles.textDecorationColor && el.styles.textDecorationColor !== "currentcolor")
          ? el.styles.textDecorationColor : fillColor,
        style: el.styles.textDecorationStyle,
        thickness: el.styles.textDecorationThickness,
        underlineOffset: el.styles.textUnderlineOffset,
        lengthScale: decorationLengthScale(el.styles),
      }] : []),
  ];
  if (applied.length === 0) return "";
  const wm = seg.verticalWritingMode ?? "vertical-rl";
  const segFontSize = seg.fontSize ?? (parseFloat(el.styles.fontSize) || 14);
  const segFamily = capturedSegmentFontFamily(el, seg);
  const segWeight = seg.fontWeight ?? el.styles.fontWeight;
  const segStyle = seg.fontStyle ?? el.styles.fontStyle;
  const segAscent = seg.fontAscent ?? el.fontAscent ?? segFontSize * 0.85;
  const segDescent = el.fontDescent ?? Math.max(0, segFontSize - segAscent);
  const resolution = resolveVerticalDecoration(
    wm, el.styles.textOrientation, el.styles.textUnderlinePosition, el.styles.lang,
  );
  const runXOffsets = seg.yOffsets?.map((y) => y - seg.y);
  const skipText = verticalDecorationSkipInkText(seg);
  const features = capturedTextSegmentFontFeatures(el, seg);
  const idBase = verticalDecorationIdBase(el, seg);
  const lineRelative = applied.map((deco, index) => renderTextDecoration({
    textDecorationLine: deco.line,
    decorationColor: deco.color,
    style: deco.style,
    segX: seg.x,
    fragTop: seg.y,
    runBaselineY: seg.y + segAscent,
    segWidth: seg.height,
    fontAscent: segAscent,
    fontDescent: segDescent,
    fontSize: segFontSize,
    fontFamily: segFamily,
    fontWeight: segWeight,
    fontStyle: segStyle,
    fontStretch: el.styles.fontStretch,
    lang: el.styles.lang,
    variationSettings: parseFontVariationSettings(el.styles.fontVariationSettings),
    // Blink disables a non-horizontal decorating box, so inherited
    // declarations remain but UsedFont/metrics are the TARGET vertical run.
    thicknessOverride: deco.thickness,
    underlineOffset: deco.underlineOffset,
    lengthScale: deco.lengthScale,
    underlinePosition: resolution.underlinePosition,
    baselineType: resolution.baselineType,
    flipUnderlineAndOverline: resolution.flipUnderlineAndOverline,
    runText: skipText,
    skipInk: el.styles.textDecorationSkipInk,
    features,
    runXOffsets,
    idBase: `${idBase}-${index}`,
  })).join("");
  if (lineRelative === "") return "";
  return `<g transform="${lineRelativeToPhysicalTransform(seg.x, seg.y, seg.width, seg.height, wm)}">${lineRelative}</g>`;
}

/**
 * Render all vertical segments on an element. Returns the concatenated
 * SVG markup; caller wraps in `<g clip-path="..." style="...">` etc.
 */
export function renderVerticalSegments(el: CapturedElement, fillColor: string): string {
  if (el.textSegments == null) return "";
  const fontSize = parseFloat(el.styles.fontSize) || 14;
  const out: string[] = [];

  for (const seg of el.textSegments) {
    if (seg.verticalWritingMode == null) continue;
    const segText = seg.text;
    const segFontSize = seg.fontSize ?? fontSize;
    // Generated line-clamp fragments are styled from the IFC root, while a
    // retained inline run may carry its own face/weight/style.  Honor the
    // captured run facts rather than flattening every column to the host.
    const fontFamily = capturedSegmentFontFamily(el, seg);
    const fontWeight = seg.fontWeight ?? el.styles.fontWeight;
    const fontStyle = seg.fontStyle ?? el.styles.fontStyle;
    // DM-2193: the baseline belongs to the captured vertical run. New captures
    // carry it on every column/combine segment; the element metric supports
    // older captures, and 0.85em remains only for legacy trees with neither.
    const segAscent = seg.fontAscent ?? el.fontAscent ?? segFontSize * 0.85;
    // DM-1032: tate-chu-yoko — one combined upright HORIZONTAL run in a single
    // ~1em column cell. Handled BEFORE the per-char column fields are required
    // (a combine segment carries none of `yOffsets`/`verticalOrientations`/
    // `verticalAdvances`). Emit it as a single `renderTextAsPath` call anchored
    // at the captured cell left (`seg.x`) and the upright baseline, with each
    // glyph placed at its captured per-char x (`verticalCombineXOffsets`) so the
    // side-by-side combined digits land exactly where Chrome painted them. Uses
    // the same `ascentOverride = 0` + captured-run-ascent baseline as the upright
    // per-char path. Bypasses the per-char upright/rotated walk below.
    if (seg.verticalCombineUpright) {
      const decoMarkupC = renderVerticalDecoration(el, seg, fillColor);
      if (decoMarkupC !== "") out.push(decoMarkupC);
      const baseline = seg.y + segAscent;
      const inner = renderTextAsPath(segText, seg.x, baseline, {
        fontSize: segFontSize, fontFamily, fontWeight, fill: fillColor,
        xOffsets: seg.verticalCombineXOffsets, fontStyle, ascentOverride: 0,
        fontStretch: el.styles.fontStretch,
      });
      out.push(inner);
      continue;
    }
    // Blink keys fallback by FontDescription::Orientation for the whole run,
    // not by each glyph's eventual upright/rotated paint orientation.
    const fontOrientation = blinkFontOrientation(seg.verticalWritingMode, el.styles.textOrientation);
    const yOffsets = seg.yOffsets;
    const orientations = seg.verticalOrientations;
    const advances = seg.verticalAdvances;
    const naturalWidths = seg.verticalNaturalWidths;
    if (yOffsets == null || orientations == null || advances == null) continue;
    // DM-997: vertical text-decoration painter. Emits BEFORE the glyphs
    // so the line paints behind (matching Chrome's stacking order).
    const decoMarkup = renderVerticalDecoration(el, seg, fillColor);
    if (decoMarkup !== "") out.push(decoMarkup);
    const colX = seg.x;
    const colW = seg.width;
    let i = 0;
    while (i < segText.length) {
      const code = segText.charCodeAt(i);
      const isHigh = code >= 0xD800 && code <= 0xDBFF && i + 1 < segText.length;
      const step = isHigh ? 2 : 1;
      const ch = segText.slice(i, i + step);
      if (/\s/.test(ch) && step === 1) { i += step; continue; }
      const orientation = orientations[i] ?? "upright";
      const charY = yOffsets[i] ?? seg.y;
      const charH = advances[i] ?? segFontSize;
      if (orientation === "rotated") {
        // Blink paints vertical fragments in a line-relative coordinate space:
        // +x is line-right and +y is line-under. The fragment's physical
        // top-left is reused as the line-relative origin, width/height swap,
        // and `ComputeRelativeToPhysicalTransform` supplies this exact affine
        // transform. This removes the old 1.2em box and center-rotation fit.
        const inner = renderTextAsPath(ch, colX, charY, {
          fontSize: segFontSize, fontFamily, fontWeight, fill: fillColor,
          fontStyle, ascentOverride: segAscent,
          fontOrientation,
          fontStretch: el.styles.fontStretch,
        });
        const transform = lineRelativeToPhysicalTransform(
          colX, charY, colW, charH, seg.verticalWritingMode,
        );
        out.push(`<g transform="${transform}">${inner}</g>`);
      } else {
        // Upright char (DM-996 / DM-2193): baseline at the captured run's
        // FontMetrics ascent from the physical character-box top.
        // Center the glyph horizontally in the column using the
        // canvas-probed natural width per char from capture.
        //
        // `renderTextAsPath` treats `y` as the line-box TOP and adds the
        // font ascent to get the baseline, so pass `ascentOverride = 0`
        // to keep the baseline at exactly the `charY + segAscent` we already
        // resolved. Without the override the ascent was added a second
        // time and every upright glyph dropped ~0.85em below its cell.
        const baseline = charY + segAscent;
        // DM-1122: CJK punctuation (。 、 brackets …) substitutes a vertical-form
        // glyph under the `vert` feature, with its ink in the cell's top-right
        // corner. Anchor the FULL em box to the column (not the ink width) so the
        // corner-set glyph lands where Chrome paints it; pass `["vert"]` so
        // fontkit performs the substitution. Other glyphs keep ink-centering and
        // no feature (a no-op `vert` would be harmless, but skipping it avoids a
        // needless re-shape per ideograph).
        const vertPunct = hasVerticalFormPunctuation(ch);
        const naturalW = vertPunct ? segFontSize : (naturalWidths?.[i] ?? segFontSize);
        const xLeft = colX + (colW - naturalW) / 2;
        const inner = renderTextAsPath(ch, xLeft, baseline, {
          fontSize: segFontSize, fontFamily, fontWeight, fill: fillColor,
          fontStyle, ascentOverride: 0,
          fontOrientation,
          features: vertPunct ? ["vert"] : undefined,
          fontStretch: el.styles.fontStretch,
        });
        out.push(inner);
      }
      i += step;
    }
  }
  // DM-1054: text-emphasis marks beside the column (vertical equivalent of the
  // horizontal renderTextEmphasisMarks, which the vertical path never reached).
  const emphasis = renderVerticalEmphasisMarks(el, fillColor);
  if (emphasis !== "") out.push(emphasis);
  return out.join("");
}

/** Blink FontDescription::Orientation values used by the fallback-cache key. */
export function blinkFontOrientation(writingMode?: string, textOrientation?: string): 0 | 1 | 2 | 3 {
  if (writingMode == null || writingMode.startsWith("horizontal")) return 0;
  if (writingMode.startsWith("sideways") || textOrientation === "sideways") return 1;
  return textOrientation === "upright" ? 3 : 2;
}

/**
 * Detect if an element should dispatch to the vertical renderer:
 * any segment with `verticalWritingMode` set.
 */
export function hasVerticalSegments(el: CapturedElement): boolean {
  if (el.textSegments == null) return false;
  for (const seg of el.textSegments) {
    if (seg.verticalWritingMode != null) return true;
  }
  return false;
}
