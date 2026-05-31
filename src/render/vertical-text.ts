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
 *   - rotated  → render the char at the origin (baseline at y=fontSize),
 *                  then transform `translate(tx, ty) rotate(90)` so the
 *                  rotated glyph lands at Chrome's painted Range rect.
 *                  `tx, ty` derived from font ascent/descent so post-
 *                  rotation the glyph's ink bbox matches the captured
 *                  per-char rect.
 *
 * `Range.height` per char (captured as `verticalAdvances[i]`) is the
 * char's advance along the column axis. For upright CJK chars this is
 * ~font-size. For rotated Latin chars this is the char's natural
 * horizontal advance (the char's pre-rotation width = post-rotation
 * vertical advance).
 */

import type { CapturedElement } from "../capture/types.js";
import { renderTextAsPath } from "./text-to-path.js";

function r(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
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
  // fontBoundingBoxAscent in `walker/text-segments.ts`). Used for both
  // upright baseline placement and rotated translation derivation.
  // Fall back to a 0.85em heuristic when undefined (e.g. early test
  // fixtures pre-DM-996; production capture always provides it).
  const elAscent = el.fontAscent ?? fontSize * 0.85;
  const elDescent = fontSize * 1.137 - elAscent; // approximate line-box descent
  const out: string[] = [];

  for (const seg of el.textSegments) {
    if (seg.verticalWritingMode == null) continue;
    const segText = seg.text;
    const yOffsets = seg.yOffsets;
    const orientations = seg.verticalOrientations;
    const advances = seg.verticalAdvances;
    const naturalWidths = seg.verticalNaturalWidths;
    if (yOffsets == null || orientations == null || advances == null) continue;
    const colX = seg.x;
    const colW = seg.width;
    // DM-996: `sideways-lr` rotates text 90° COUNTER-clockwise (text
    // reads bottom-to-top, char tops point LEFT). The other three modes
    // (`vertical-rl`, `vertical-lr`, `sideways-rl`) rotate 90° CW for
    // rotated chars (text reads top-to-bottom, char tops point RIGHT).
    const rotateAngle = seg.verticalWritingMode === "sideways-lr" ? -90 : 90;

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
        // Rotated char: emit the glyph at origin (baseline at
        // (0, fontSize)) then `translate(centerX, centerY) rotate(90)
        // translate(-renderCx, -renderCy)` to land it in the column's
        // captured Range rect. The compose-and-rotate-around-center
        // formulation is empirically correct for the natural case
        // where Chrome's painted Range width = column line-box (this
        // is the common case — verified for the fixture's 18px vrl
        // box where Range.w=21 matches the line-box at that font).
        const charNaturalW = charH; // = char's pre-rotation advance
        const renderedH = fontSize * 1.2; // approximate line-box height
        const renderCx = charNaturalW / 2;
        const renderCy = renderedH / 2;
        const centerX = colX + colW / 2;
        const centerY = charY + charH / 2;
        const inner = renderTextAsPath(
          ch, 0, fontSize, fontSize, fontFamily, fontWeight,
          fillColor, undefined, undefined, undefined, fontStyle,
        );
        if (inner == null) { i += step; continue; }
        const transform = `translate(${r(centerX)}, ${r(centerY)}) rotate(${rotateAngle}) translate(${r(-renderCx)}, ${r(-renderCy)})`;
        out.push(`<g transform="${transform}">${inner}</g>`);
      } else {
        // Upright char (DM-996): baseline at charY + 0.85em (heuristic
        // — tighter font-metric-driven baseline produced regressions in
        // other fixtures since canvas-measured `fontAscent` reports
        // horizontal-text metrics, not the vertical-text vhea ones).
        // Center the glyph horizontally in the column using the
        // canvas-probed natural width per char from capture.
        const baseline = charY + fontSize * 0.85;
        const naturalW = naturalWidths?.[i] ?? fontSize;
        const xLeft = colX + (colW - naturalW) / 2;
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
