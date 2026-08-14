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

import type { CapturedElement } from "../capture/types.js";
import { measureEmphasisMarkMetrics, renderTextAsPath } from "./text-to-path.js";
import { emphasisGraphemeSpans, parseTextEmphasisMark } from "./text.js";
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
    const segFamily = seg.fontFamily ?? el.styles.fontFamily;
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

/**
 * DM-997: emit a vertical text-decoration line (underline / overline /
 * line-through) for a column segment. Vertical text decorations paint
 * OUTSIDE the inline-box, parallel to the column axis, with position
 * driven by `text-underline-position` (`left` / `right` / `auto`). The
 * decoration line spans the column's full height (segment.y to
 * segment.y + segment.height).
 */
function renderVerticalDecoration(
  el: CapturedElement,
  seg: { x: number; y: number; width: number; height: number; verticalWritingMode?: string },
  fillColor: string,
): string {
  const decoLine = el.styles.textDecorationLine;
  if (decoLine == null || decoLine === "none" || decoLine === "") return "";
  const decoColor = (el.styles.textDecorationColor && el.styles.textDecorationColor !== "currentcolor")
    ? el.styles.textDecorationColor : fillColor;
  const thicknessRaw = el.styles.textDecorationThickness;
  const thickness = thicknessRaw && thicknessRaw !== "auto" && thicknessRaw !== ""
    ? parseFloat(thicknessRaw) || 1
    : Math.max(1, parseFloat(el.styles.fontSize) / 18); // ~1 px at body sizes
  const underlinePos = (el.styles.textUnderlinePosition ?? "auto").trim();
  const wm = seg.verticalWritingMode ?? "vertical-rl";
  // Default underline side for `auto`. Verified against Chrome's painted output
  // (DM-1159): the `under`-baseline underline lands on the LEFT of the column
  // for vertical-rl, vertical-lr AND sideways-rl, and on the RIGHT only for
  // sideways-lr (its 90° COUNTER-clockwise rotation flips the under side to the
  // right). The earlier "auto → right for vertical-rl" rule was backwards — the
  // pos-auto cell painted its underline on the wrong (right) side.
  const defaultRight = wm === "sideways-lr";
  const onLeft = underlinePos === "left" || (underlinePos === "auto" && !defaultRight);
  const onRight = underlinePos === "right" || (underlinePos === "auto" && defaultRight);
  const offset = 1; // small offset from column edge
  const lines: string[] = [];
  const has = (k: string): boolean => decoLine.includes(k);
  // X-coordinate for vertical underline / overline / line-through.
  const colLeftX = seg.x - offset - thickness / 2;
  const colRightX = seg.x + seg.width + offset + thickness / 2;
  const colMidX = seg.x + seg.width / 2;
  const yTop = seg.y;
  const yBot = seg.y + seg.height;
  if (has("underline")) {
    const lineX = onLeft ? colLeftX : colRightX;
    lines.push(`<line x1="${r(lineX)}" y1="${r(yTop)}" x2="${r(lineX)}" y2="${r(yBot)}" stroke="${decoColor}" stroke-width="${r(thickness)}" />`);
  }
  if (has("overline")) {
    // Overline is the OPPOSITE side of underline.
    const lineX = onLeft ? colRightX : colLeftX;
    lines.push(`<line x1="${r(lineX)}" y1="${r(yTop)}" x2="${r(lineX)}" y2="${r(yBot)}" stroke="${decoColor}" stroke-width="${r(thickness)}" />`);
  }
  if (has("line-through")) {
    // Line-through paints through the middle of the column (perpendicular
    // to the column axis, so a VERTICAL line down the column's mid-x).
    lines.push(`<line x1="${r(colMidX)}" y1="${r(yTop)}" x2="${r(colMidX)}" y2="${r(yBot)}" stroke="${decoColor}" stroke-width="${r(thickness)}" />`);
  }
  return lines.join("");
}

/**
 * Render all vertical segments on an element. Returns the concatenated
 * SVG markup; caller wraps in `<g clip-path="..." style="...">` etc.
 */
export function renderVerticalSegments(el: CapturedElement, fillColor: string): string {
  if (el.textSegments == null) return "";
  const fontSize = parseFloat(el.styles.fontSize) || 14;
  const fontFamily = el.styles.fontFamily;
  const fontWeight = el.styles.fontWeight;
  const fontStyle = el.styles.fontStyle;
  // Element-level fontAscent (captured via canvas measureText
  // fontBoundingBoxAscent in `walker/text-segments.ts`). Used for the
  // line-relative text origin of rotated glyphs.
  // Fall back to a 0.85em heuristic when undefined (e.g. early test
  // fixtures pre-DM-996; production capture always provides it).
  const elAscent = el.fontAscent ?? fontSize * 0.85;
  const out: string[] = [];

  for (const seg of el.textSegments) {
    if (seg.verticalWritingMode == null) continue;
    const segText = seg.text;
    // DM-1032: tate-chu-yoko — one combined upright HORIZONTAL run in a single
    // ~1em column cell. Handled BEFORE the per-char column fields are required
    // (a combine segment carries none of `yOffsets`/`verticalOrientations`/
    // `verticalAdvances`). Emit it as a single `renderTextAsPath` call anchored
    // at the captured cell left (`seg.x`) and the upright baseline, with each
    // glyph placed at its captured per-char x (`verticalCombineXOffsets`) so the
    // side-by-side combined digits land exactly where Chrome painted them. Uses
    // the same `ascentOverride = 0` + `charTop + 0.85em` baseline as the upright
    // per-char path. Bypasses the per-char upright/rotated walk below.
    if (seg.verticalCombineUpright) {
      const decoMarkupC = renderVerticalDecoration(el, seg, fillColor);
      if (decoMarkupC !== "") out.push(decoMarkupC);
      const baseline = seg.y + fontSize * 0.85;
      const inner = renderTextAsPath(segText, seg.x, baseline, {
        fontSize, fontFamily, fontWeight, fill: fillColor,
        xOffsets: seg.verticalCombineXOffsets, fontStyle, ascentOverride: 0,
        fontStretch: el.styles.fontStretch,
      });
      if (inner != null) out.push(inner);
      continue;
    }
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
      const charH = advances[i] ?? fontSize;
      if (orientation === "rotated") {
        // Blink paints vertical fragments in a line-relative coordinate space:
        // +x is line-right and +y is line-under. The fragment's physical
        // top-left is reused as the line-relative origin, width/height swap,
        // and `ComputeRelativeToPhysicalTransform` supplies this exact affine
        // transform. This removes the old 1.2em box and center-rotation fit.
        const inner = renderTextAsPath(ch, colX, charY, {
          fontSize, fontFamily, fontWeight, fill: fillColor,
          fontStyle, ascentOverride: elAscent,
          fontStretch: el.styles.fontStretch,
        });
        if (inner == null) { i += step; continue; }
        const transform = lineRelativeToPhysicalTransform(
          colX, charY, colW, charH, seg.verticalWritingMode,
        );
        out.push(`<g transform="${transform}">${inner}</g>`);
      } else {
        // Upright char (DM-996): baseline at charY + 0.85em (heuristic
        // — tighter font-metric-driven baseline produced regressions in
        // other fixtures since canvas-measured `fontAscent` reports
        // horizontal-text metrics, not the vertical-text vhea ones).
        // Center the glyph horizontally in the column using the
        // canvas-probed natural width per char from capture.
        //
        // `renderTextAsPath` treats `y` as the line-box TOP and adds the
        // font ascent to get the baseline, so pass `ascentOverride = 0`
        // to keep the baseline at exactly the `charY + 0.85em` we already
        // resolved. Without the override the ascent was added a second
        // time and every upright glyph dropped ~0.85em below its cell.
        const baseline = charY + fontSize * 0.85;
        // DM-1122: CJK punctuation (。 、 brackets …) substitutes a vertical-form
        // glyph under the `vert` feature, with its ink in the cell's top-right
        // corner. Anchor the FULL em box to the column (not the ink width) so the
        // corner-set glyph lands where Chrome paints it; pass `["vert"]` so
        // fontkit performs the substitution. Other glyphs keep ink-centering and
        // no feature (a no-op `vert` would be harmless, but skipping it avoids a
        // needless re-shape per ideograph).
        const vertPunct = hasVerticalFormPunctuation(ch);
        const naturalW = vertPunct ? fontSize : (naturalWidths?.[i] ?? fontSize);
        const xLeft = colX + (colW - naturalW) / 2;
        const inner = renderTextAsPath(ch, xLeft, baseline, {
          fontSize, fontFamily, fontWeight, fill: fillColor,
          fontStyle, ascentOverride: 0,
          features: vertPunct ? ["vert"] : undefined,
          fontStretch: el.styles.fontStretch,
        });
        if (inner != null) out.push(inner);
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
