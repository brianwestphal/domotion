/**
 * DM-990: vertical writing-mode text renderer.
 *
 * Emits per-column SVG markup for `writing-mode: vertical-rl` /
 * `vertical-lr` / `sideways-rl` / `sideways-lr` elements. Each captured
 * `TextSegment` represents ONE column of chars (grouped by matching
 * `x` ±1 px at capture time); within each segment, `text[i]` is the
 * char at `yOffsets[i]` with orientation `verticalOrientations[i]`.
 *
 * Per-char emission:
 *   - upright  → render the char at its natural horizontal layout with
 *                  baseline shifted by the column's per-char y position
 *                  + the font's vertical metrics origin. Chrome's
 *                  `Range.getBoundingClientRect()` gives the char's
 *                  painted box in viewport coords; the renderer matches
 *                  that box.
 *   - rotated  → render the char at its natural layout, then wrap the
 *                  emitted SVG in `<g transform="rotate(90, cx, cy)">`
 *                  so the glyph's horizontal advance becomes vertical
 *                  along the column. Rotation pivots around the
 *                  char's painted-rect center so the rotated glyph
 *                  lands in the same box Chrome painted.
 *
 * `Range.height` per char (captured as `verticalAdvances[i]`) is the
 * char's advance along the column axis. For upright CJK chars this is
 * ~font-size. For rotated Latin chars this is the char's natural
 * horizontal advance (the char's pre-rotation width).
 */

import type { TextSegment, CapturedElement } from "../capture/types.js";
import { renderTextAsPath } from "./text-to-path.js";

function r(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

/**
 * Render all vertical segments on an element. Returns the concatenated
 * SVG markup (one `<g>` per column wrapping per-char `<text>` / `<g
 * transform=rotate>` elements). Caller handles the outer wrapping
 * (`<g clip-path="..." style="...">` etc.) — this function emits only
 * the inner glyph markup so the caller can compose it with the rest of
 * the element's paint.
 */
export function renderVerticalSegments(el: CapturedElement, fillColor: string): string {
  if (el.textSegments == null) return "";
  const fontSize = parseFloat(el.styles.fontSize) || 14;
  const fontFamily = el.styles.fontFamily;
  const fontWeight = el.styles.fontWeight;
  const fontStyle = el.styles.fontStyle;
  const out: string[] = [];

  for (const seg of el.textSegments) {
    if (seg.verticalWritingMode == null) continue;
    const segText = seg.text;
    const yOffsets = seg.yOffsets;
    const orientations = seg.verticalOrientations;
    const advances = seg.verticalAdvances;
    if (yOffsets == null || orientations == null || advances == null) continue;

    // Iterate per UTF-16 code unit. Combine surrogate pairs by detecting
    // high surrogates and consuming the next index.
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
      // Column x / width — the segment's painted column.
      const colX = seg.x;
      const colW = seg.width;
      if (orientation === "rotated") {
        // For a rotated char, Chrome paints the glyph such that its
        // natural HORIZONTAL advance now flows along the column's
        // vertical axis. The captured `charH` (Range.height) IS that
        // post-rotation advance — i.e. the char's natural horizontal
        // width pre-rotation. Render the char at an offscreen position
        // (origin 0,0) and apply a transform that places it at the
        // column position, rotated 90° clockwise around the char's
        // intended center.
        //
        // The transform composes as:
        //   translate(centerX, centerY) rotate(90) translate(-renderCx, -renderCy)
        // where centerX/Y is where we want the glyph's center to land
        // in the page coord system, and renderCx/Cy is the center of
        // the glyph as it sits at its origin pre-transform.
        //
        // The glyph natural width ≈ charH (since post-rotation char's
        // vertical advance = pre-rotation horizontal advance). Render at
        // (x=0, y=fontSize) — y=fontSize places the baseline so glyph
        // ink extends from y=fontSize-ascent up to y=fontSize+descent.
        // Then center the glyph in (charH × fontSize) box and rotate.
        const renderedW = charH; // natural horizontal width pre-rotation
        const renderedH = fontSize * 1.2; // approximate line-box height; only needs to be near-correct for centering
        const renderCx = renderedW / 2;
        const renderCy = renderedH / 2;
        const centerX = colX + colW / 2;
        const centerY = charY + charH / 2;
        const inner = renderTextAsPath(
          ch, 0, fontSize, fontSize, fontFamily, fontWeight,
          fillColor, undefined, undefined, undefined, fontStyle,
        );
        if (inner == null) { i += step; continue; }
        const transform = `translate(${r(centerX)}, ${r(centerY)}) rotate(90) translate(${r(-renderCx)}, ${r(-renderCy)})`;
        out.push(`<g transform="${transform}">${inner}</g>`);
      } else {
        // Upright: glyph paints with normal horizontal layout but
        // centered in the column. For CJK glyphs at em-size font-size
        // this looks visually similar to Chrome's painted column.
        // Position: baseline at charY + ascent. Render the glyph at the
        // column-center x with its baseline at the right y.
        // The natural width of the char varies (CJK ~em, narrower for
        // halfwidth). renderTextAsPath positions text by its left edge
        // at the given x — we want the GLYPH centered in the column.
        // Compromise: render at x = colX + small left-padding (~1 px).
        // For better centering we'd need glyph-width measurement; defer.
        const baseline = charY + fontSize * 0.85; // ascent ~= 0.85em for CJK
        const xLeft = colX + 1;
        const inner = renderTextAsPath(
          ch, xLeft, baseline, fontSize, fontFamily, fontWeight,
          fillColor, undefined, undefined, undefined, fontStyle,
        );
        if (inner != null) out.push(inner);
      }
      i += step;
    }
  }
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
