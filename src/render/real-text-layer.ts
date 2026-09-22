/** Opt-in authored-text overlay for inline SVG consumers (DM-1775). */

import type { CapturedElement, CapturedTextPaintAffine, TextSegment } from "../capture/types.js";
import { esc, r } from "./format.js";
import {
  visualTextOnlyHiddenAttr,
  visualTextSemantics,
  withTextEngineVisualSemanticsSuppressed,
} from "./text-semantics.js";
import {
  IDENTITY_TEXT_AFFINE,
  prepareAffineTextPaint,
  serializeTextPaintMatrix,
  textAffineEquals,
} from "./text-affine.js";

/** Preserve Blink's 1/64px layout positions without carrying float noise. */
const position = (value: number): string => Number(value.toFixed(3)).toString();

/** Suppress duplicate run-level labels while a real-text layer owns semantics. */
export function withRealTextLayerVisualSemantics<T>(render: () => T): T {
  return withTextEngineVisualSemanticsSuppressed(render);
}

export { visualTextOnlyHiddenAttr, visualTextSemantics };

interface RealTextRun {
  element: CapturedElement;
  segment: TextSegment;
  transform?: CapturedTextPaintAffine;
  sequence: number;
}

function sourceText(segment: TextSegment): string {
  // Blink FragmentItem offsets are exact UTF-16 TextOffsetRange values
  // (`external/chromium/.../layout/inline/fragment_item.h:448-451`). HarfBuzz
  // likewise defines `cluster` as an index into the original text
  // (`external/harfbuzz/src/hb-buffer.h:47-56`). Keep that shared indexing;
  // this semantic layer never derives source characters from shaped glyphs.
  const mapping = segment.sourceMapping;
  if (mapping != null) {
    const [start, end] = mapping.domUtf16Span;
    if (
      Number.isInteger(start) &&
      Number.isInteger(end) &&
      start >= 0 &&
      end >= start &&
      end <= mapping.domText.length
    ) {
      return mapping.domText.slice(start, end);
    }
  }
  return segment.sourceText ?? segment.text;
}

/** Capture arrays are indexed by UTF-16 code unit; SVG position lists address
 * Unicode scalars, so an astral pair deliberately consumes one shared value. */
function codePointPositions(text: string, positions: readonly number[] | undefined): number[] | undefined {
  if (positions == null) return undefined;
  const output: number[] = [];
  let utf16 = 0;
  for (const char of text) {
    const position = positions[utf16];
    if (!Number.isFinite(position)) return undefined;
    output.push(position);
    utf16 += char.length;
  }
  return output;
}

/** Map authored code points to the first rendered coordinate in their source
 * chunk. Length-changing CSS text transforms therefore keep authored strings
 * without inventing intermediate layout positions. */
function authoredPositions(segment: TextSegment, positions: readonly number[] | undefined): number[] | undefined {
  const mapping = segment.sourceMapping;
  if (mapping == null || positions == null) return codePointPositions(sourceText(segment), positions);
  const [spanStart, spanEnd] = mapping.domUtf16Span;
  const authored = mapping.domText.slice(spanStart, spanEnd);
  const chunks = [...mapping.renderedChunks].sort((a, b) => a.domUtf16Span[0] - b.domUtf16Span[0]);
  const output: number[] = [];
  let localUtf16 = 0;
  let chunkIndex = 0;
  for (const char of authored) {
    const absolute = spanStart + localUtf16;
    while (chunks[chunkIndex] != null && absolute >= chunks[chunkIndex].domUtf16Span[1]) chunkIndex++;
    const chunk = chunks[chunkIndex];
    const coordinate = chunk == null ? undefined : positions[chunk.renderedUtf16Span[0]];
    if (chunk == null || absolute < chunk.domUtf16Span[0] || !Number.isFinite(coordinate)) return undefined;
    output.push(coordinate as number);
    localUtf16 += char.length;
  }
  return output;
}

function synthesizedInputSegment(el: CapturedElement): TextSegment | null {
  if (el.text === "" || (el.inputXOffsets == null && el.textLeft == null)) return null;
  return {
    text: el.text,
    x: el.textLeft ?? el.x + 4,
    y: el.textTop ?? el.y,
    width: el.textWidth ?? el.width,
    height: el.textHeight ?? el.height,
    xOffsets: el.inputXOffsets,
    fontAscent: el.fontAscent,
  };
}

function collectRuns(roots: readonly CapturedElement[]): RealTextRun[] {
  const runs: RealTextRun[] = [];
  let sequence = 0;
  const visit = (original: CapturedElement): void => {
    // With identity as the already-emitted CTM, the residual is Chromium's
    // complete source-owned paint matrix. This layer lives at SVG root.
    const prepared = prepareAffineTextPaint(original, IDENTITY_TEXT_AFFINE);
    const el = prepared.failureReason == null ? prepared.element : original;
    const transform = prepared.failureReason == null ? prepared.residualMatrix : undefined;
    const segments =
      el.textSegments?.filter((segment) => segment.text !== "" && segment.generatedLineClampEllipsis !== true) ?? [];
    if (segments.length > 0) {
      for (const segment of segments) runs.push({ element: el, segment, transform, sequence: sequence++ });
    } else {
      const input = synthesizedInputSegment(el);
      if (input != null) runs.push({ element: el, segment: input, transform, sequence: sequence++ });
    }
    for (const child of original.children) visit(child);
  };
  for (const root of roots) visit(root);

  // Source node indices restore parent/child DOM interleave that the captured
  // element tree alone cannot express. Sort only the authored slots so
  // generated/input runs retain stable capture positions and the comparator
  // cannot become non-transitive across mapped and unmapped runs.
  const authored = runs
    .filter((run) => run.segment.sourceMapping != null)
    .sort((left, right) => {
      const a = left.segment.sourceMapping?.sourceTextNodeIndex;
      const b = right.segment.sourceMapping?.sourceTextNodeIndex;
      if (a !== b) return a! - b!;
      const span = left.segment.sourceMapping!.domUtf16Span[0] - right.segment.sourceMapping!.domUtf16Span[0];
      if (span !== 0) return span;
      return left.sequence - right.sequence;
    });
  let authoredIndex = 0;
  return runs.map((run) => (run.segment.sourceMapping == null ? run : authored[authoredIndex++]!));
}

function runMarkup(run: RealTextRun, index: number): string {
  const { element: el, segment } = run;
  const text = sourceText(segment);
  if (text === "") return "";
  const vertical = segment.verticalWritingMode != null && segment.verticalWritingMode !== "horizontal-tb";
  const parsedFontSize = Number.parseFloat(el.styles.fontSize);
  const fontSize = segment.fontSize ?? (Number.isFinite(parsedFontSize) ? parsedFontSize : 14);
  const ascent = segment.fontAscent ?? el.fontAscent ?? fontSize * 0.8;
  const direction = el.styles.direction === "rtl" ? ` direction="rtl"` : "";
  const transform =
    run.transform != null && !textAffineEquals(run.transform, IDENTITY_TEXT_AFFINE)
      ? ` transform="${serializeTextPaintMatrix(run.transform)}"`
      : "";
  const length = vertical ? segment.height : segment.width;
  const lengthAttrs =
    Number.isFinite(length) && length > 0
      ? // Native SVGTextContentElement owns textLength/lengthAdjust; see Blink's
        // `core/svg/svg_text_content_element.h:68-73`. This affects only selection
        // geometry because both paint channels are disabled on the parent layer.
        ` textLength="${position(length)}" lengthAdjust="spacingAndGlyphs"`
      : "";
  if (vertical) {
    const positions = authoredPositions(segment, segment.yOffsets);
    const y = positions?.length ? positions.map(position).join(" ") : position(segment.y);
    const x = position(segment.baseline ?? segment.x + ascent);
    return `<text data-domotion-real-text-run="${index}" x="${x}" y="${y}" font-size="${r(fontSize)}" writing-mode="${esc(segment.verticalWritingMode!)}"${direction}${lengthAttrs}${transform}>${esc(text)}</text>`;
  }
  const positions = authoredPositions(segment, segment.xOffsets);
  const x = positions?.length ? positions.map(position).join(" ") : position(segment.x);
  const baseline = segment.baseline ?? Math.floor(segment.y + ascent + 0.5);
  return `<text data-domotion-real-text-run="${index}" x="${x}" y="${position(baseline)}" font-size="${r(fontSize)}"${direction}${lengthAttrs}${transform}>${esc(text)}</text>`;
}

/** Emit an inline-SVG-only real-text layer. Explicit paint-none attributes
 * prevent optimizer/viewer defaults from turning fallback glyphs into ink. */
export function renderRealTextLayer(roots: readonly CapturedElement[]): string {
  const runs = collectRuns(roots).map(runMarkup).filter(Boolean);
  if (runs.length === 0) return "";
  return `<g data-domotion-real-text-layer="true" fill="none" stroke="none" xml:space="preserve">${runs.join("")}</g>`;
}
