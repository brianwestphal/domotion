/**
 * Source-owned affine text-paint composition (DM-2470).
 *
 * Blink lays out and shapes text in a pre-CSS-transform plane, then applies
 * the complete signed paint matrix.  The SVG renderer may already have
 * emitted some rotation/skew ancestors as groups, so the text branch emits
 * only `inverse(emittedCtm) * paintMatrix`.  This is matrix composition, not
 * a font-size scalar: reflection, shear, rotation, translation, and unequal
 * axis scales remain intact.
 */

import type {
  CapturedElement,
  CapturedTextPaintAffine,
  CapturedTextPaintGeometry,
} from "../capture/types.js";
import { capturedTextLineOriginErrors } from "../capture/text-line-origin.js";

export const TEXT_PAINT_MATRIX_EPSILON = 1e-7;

export const IDENTITY_TEXT_AFFINE: CapturedTextPaintAffine = [1, 0, 0, 1, 0, 0];

/** Compose `outer(inner(point))`. */
export function multiplyTextAffine(
  outer: CapturedTextPaintAffine,
  inner: CapturedTextPaintAffine,
): CapturedTextPaintAffine {
  return [
    outer[0] * inner[0] + outer[2] * inner[1],
    outer[1] * inner[0] + outer[3] * inner[1],
    outer[0] * inner[2] + outer[2] * inner[3],
    outer[1] * inner[2] + outer[3] * inner[3],
    outer[0] * inner[4] + outer[2] * inner[5] + outer[4],
    outer[1] * inner[4] + outer[3] * inner[5] + outer[5],
  ];
}

export function invertTextAffine(matrix: CapturedTextPaintAffine): CapturedTextPaintAffine | null {
  const determinant = matrix[0] * matrix[3] - matrix[1] * matrix[2];
  if (!Number.isFinite(determinant) || Math.abs(determinant) <= TEXT_PAINT_MATRIX_EPSILON) return null;
  const inverse: CapturedTextPaintAffine = [
    matrix[3] / determinant,
    -matrix[1] / determinant,
    -matrix[2] / determinant,
    matrix[0] / determinant,
    0,
    0,
  ];
  inverse[4] = -(inverse[0] * matrix[4] + inverse[2] * matrix[5]);
  inverse[5] = -(inverse[1] * matrix[4] + inverse[3] * matrix[5]);
  return inverse.every(Number.isFinite) ? inverse : null;
}

export function textAffineEquals(
  left: CapturedTextPaintAffine,
  right: CapturedTextPaintAffine,
  epsilon = TEXT_PAINT_MATRIX_EPSILON,
): boolean {
  return left.every((value, index) => Math.abs(value - right[index]) <= epsilon);
}

function parseComputedAffine(transform: string | undefined): CapturedTextPaintAffine | null {
  if (transform == null || transform === "" || transform === "none") return IDENTITY_TEXT_AFFINE;
  const match = /^matrix\(\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)\s*\)$/.exec(transform);
  if (match == null) return null;
  const matrix: CapturedTextPaintAffine = [
    Number(match[1]), Number(match[2]), Number(match[3]),
    Number(match[4]), Number(match[5]), Number(match[6]),
  ];
  return matrix.every(Number.isFinite) ? matrix : null;
}

/** Exact matrix emitted by the renderer's static CSS-transform wrapper. */
export function emittedElementTextAffine(el: CapturedElement): CapturedTextPaintAffine | null {
  if (el.projectiveTransform != null) {
    const projective = el.projectiveTransform;
    // A captured projective plane is not necessarily non-affine. Perspective
    // roots themselves and planes affected only by translateZ commonly arrive
    // as a homography whose projective row is [0, 0, w]. The renderer emits
    // those first six normalized coefficients as an SVG matrix, so text must
    // include the same matrix in its already-emitted CTM.
    const w = projective[8];
    if (!Number.isFinite(w) || Math.abs(w) <= TEXT_PAINT_MATRIX_EPSILON
      || Math.abs(projective[6]) > TEXT_PAINT_MATRIX_EPSILON
      || Math.abs(projective[7]) > TEXT_PAINT_MATRIX_EPSILON) return null;
    const affine: CapturedTextPaintAffine = [
      projective[0] / w,
      projective[3] / w,
      projective[1] / w,
      projective[4] / w,
      projective[2] / w,
      projective[5] / w,
    ];
    return affine.every(Number.isFinite) ? affine : null;
  }
  const matrix = parseComputedAffine(el.styles.transform);
  if (matrix == null) return null;
  if (textAffineEquals(matrix, IDENTITY_TEXT_AFFINE)) return IDENTITY_TEXT_AFFINE;
  const origin = (el.styles.transformOrigin ?? "").trim().split(/\s+/);
  const parsedX = Number.parseFloat(origin[0] ?? "");
  const parsedY = Number.parseFloat(origin[1] ?? "");
  const ox = el.x + (Number.isFinite(parsedX) ? parsedX : el.width / 2);
  const oy = el.y + (Number.isFinite(parsedY) ? parsedY : el.height / 2);
  return multiplyTextAffine(
    [1, 0, 0, 1, ox, oy],
    multiplyTextAffine(matrix, [1, 0, 0, 1, -ox, -oy]),
  );
}

/**
 * Map each captured element to the exact static SVG CTM already surrounding
 * its content.  Hoisted descendants cannot cross a transform stacking
 * context, so DOM ancestry and emitted transform ancestry agree here.
 */
export function buildEmittedTextCtmMap(
  roots: readonly CapturedElement[],
): WeakMap<CapturedElement, CapturedTextPaintAffine | null> {
  const output = new WeakMap<CapturedElement, CapturedTextPaintAffine | null>();
  const visit = (el: CapturedElement, parent: CapturedTextPaintAffine | null): void => {
    const own = emittedElementTextAffine(el);
    const current = parent == null || own == null ? null : multiplyTextAffine(parent, own);
    output.set(el, current);
    for (const child of el.children) visit(child, current);
  };
  for (const root of roots) visit(root, IDENTITY_TEXT_AFFINE);
  return output;
}

function onePaintMatrix(geometry: CapturedTextPaintGeometry): CapturedTextPaintAffine | null {
  const first = geometry.fragments[0]?.paintMatrix;
  if (first == null) return null;
  return geometry.fragments.every((fragment) => textAffineEquals(fragment.paintMatrix, first))
    ? first
    : null;
}

function sameSpan(left: readonly number[] | undefined, right: readonly number[]): boolean {
  return left?.length === 2 && left[0] === right[0] && left[1] === right[1];
}

function sourceFragmentErrors(geometry: CapturedTextPaintGeometry): string[] {
  const errors: string[] = [];
  const sources = geometry.sourceFragments;
  if (!Array.isArray(sources) || sources.length === 0) return ["FragmentItem UTF-16 source records are unavailable"];
  const ordinaryUse = new Map<number, number>();
  for (const [index, source] of sources.entries()) {
    if (source.source !== "blink-range-fragment-utf16-v1") errors.push(`source fragment ${index} schema changed`);
    if (!Number.isInteger(source.domUtf16Span?.[0]) || !Number.isInteger(source.domUtf16Span?.[1])
      || source.domUtf16Span[0] < 0 || source.domUtf16Span[1] <= source.domUtf16Span[0]) {
      errors.push(`source fragment ${index} UTF-16 span is invalid`);
    }
    if (source.provenance?.chromiumRevision !== "7d859f271cbda744098ac69f44978d4edfa62be3"
      || source.provenance?.rangeQuads !== "core/layout/layout_text.cc:556-637"
      || source.provenance?.fragmentOffsets !== "core/layout/inline/fragment_item.h:448-451") {
      errors.push(`source fragment ${index} provenance changed`);
    }
    if (source.role === "ordinary" && source.cdpQuadIndex == null) errors.push(`ordinary source fragment ${index} lost its protocol quad`);
    if (source.role === "first-letter" && source.cdpQuadIndex != null) errors.push(`first-letter source fragment ${index} unexpectedly owns a text-node protocol quad`);
  }
  for (const [fragmentIndex, fragment] of geometry.fragments.entries()) {
    const source = sources[fragment.sourceFragmentIndex];
    if (source == null) {
      errors.push(`paint fragment ${fragmentIndex} source index is unavailable`);
      continue;
    }
    ordinaryUse.set(fragment.sourceFragmentIndex, (ordinaryUse.get(fragment.sourceFragmentIndex) ?? 0) + 1);
    if (source.role !== "ordinary"
      || source.sourceTextNodeIndex !== fragment.sourceTextNodeIndex
      || source.physicalFragmentIndex !== fragment.physicalFragmentIndex
      || !sameSpan(fragment.domUtf16Span, source.domUtf16Span)) {
      errors.push(`paint fragment ${fragmentIndex} disagrees with its UTF-16 source owner`);
    }
    const xs = [fragment.neutralQuad[0], fragment.neutralQuad[2], fragment.neutralQuad[4], fragment.neutralQuad[6]];
    const ys = [fragment.neutralQuad[1], fragment.neutralQuad[3], fragment.neutralQuad[5], fragment.neutralQuad[7]];
    if (source.neutralRangeRect.x !== Math.min(...xs)
      || source.neutralRangeRect.y !== Math.min(...ys)
      || source.neutralRangeRect.width !== Math.max(...xs) - Math.min(...xs)
      || source.neutralRangeRect.height !== Math.max(...ys) - Math.min(...ys)) {
      errors.push(`paint fragment ${fragmentIndex} Range rectangle changed`);
    }
  }
  for (const [sourceIndex, source] of sources.entries()) {
    if (source.role === "ordinary" && ordinaryUse.get(sourceIndex) !== 1) {
      errors.push(`ordinary source fragment ${sourceIndex} is not consumed exactly once`);
    }
  }
  for (const [segmentIndex, segment] of (geometry.neutral?.textSegments ?? []).entries()) {
    const mapping = segment.sourceMapping;
    if (mapping == null) continue;
    const matches = sources.filter((source) => source.sourceTextNodeIndex === mapping.sourceTextNodeIndex
      && source.role === mapping.role && sameSpan(source.domUtf16Span, mapping.domUtf16Span));
    if (matches.length !== 1) errors.push(`neutral text segment ${segmentIndex} has no unique FragmentItem UTF-16 owner`);
  }
  return errors;
}

export interface PreparedAffineTextPaint {
  element: CapturedElement;
  residualMatrix?: CapturedTextPaintAffine;
  failureReason?: string;
}

/**
 * Replace legacy mixed/post-transform text coordinates with the same-frame
 * neutral capture and return the sole residual matrix the SVG branch owns.
 */
export function prepareAffineTextPaint(
  el: CapturedElement,
  emittedCtm: CapturedTextPaintAffine | null | undefined,
): PreparedAffineTextPaint {
  const geometry = el.textPaintGeometry;
  if (geometry == null) return { element: el };
  const neutral = geometry.neutral;
  if (neutral == null) return { element: el, failureReason: "neutral text paint bundle unavailable" };
  const spanErrors = sourceFragmentErrors(geometry);
  if (spanErrors.length > 0) {
    return { element: el, failureReason: `invalid Blink FragmentItem source record: ${spanErrors.join("; ")}` };
  }
  const paintMatrix = onePaintMatrix(geometry);
  if (paintMatrix == null) return { element: el, failureReason: "text fragments do not share one affine paint plane" };
  const inverse = emittedCtm == null ? null : invertTextAffine(emittedCtm);
  if (inverse == null) return { element: el, failureReason: "emitted text ancestor matrix is singular" };
  const fragmentsBySegment = new Map(geometry.fragments.map((fragment) => [fragment.textSegmentIndex, fragment]));
  for (const [index, segment] of (neutral.textSegments ?? []).entries()) {
    const fragment = fragmentsBySegment.get(index);
    if (fragment == null) continue;
    const errors = capturedTextLineOriginErrors(fragment.lineOrigin, {
      fragmentLeft: segment.x,
      fragmentTop: segment.y,
      fragmentWidth: segment.width,
      fragmentHeight: segment.height,
      writingMode: fragment.writingMode,
      effectiveZoom: fragment.lineOrigin.effectiveZoom,
    });
    if (errors.length > 0) {
      return { element: el, failureReason: `invalid Blink line-relative text origin: ${errors.join("; ")}` };
    }
  }
  const element: CapturedElement = {
    ...el,
    x: neutral.x,
    y: neutral.y,
    width: neutral.width,
    height: neutral.height,
    text: neutral.text,
    textSegments: neutral.textSegments?.map((segment, index) => {
      const fragment = fragmentsBySegment.get(index);
      if (fragment == null) return { ...segment };
      const vertical = fragment.writingMode.startsWith("vertical") || fragment.writingMode.startsWith("sideways");
      const lineOrigin = fragment.lineOrigin;
      const fragmentTop = lineOrigin.roundedContainingPaintOffsetTop + lineOrigin.fragmentRelativeTop;
      const topDelta = fragmentTop - segment.y;
      return {
        ...segment,
        y: fragmentTop,
        baseline: vertical
          ? lineOrigin.physicalBaselinePoint.x
          : lineOrigin.physicalBaselinePoint.y,
        inlineOffset: fragment.inlineOffset,
        fontAscent: lineOrigin.primaryFontIntegerAscent,
        xOffsets: vertical ? segment.xOffsets : [...fragment.shapedOrigins],
        xAdvances: vertical ? segment.xAdvances : [...fragment.shapedAdvances],
        yOffsets: vertical ? fragment.shapedOrigins.map((origin) => origin + topDelta) : segment.yOffsets,
        verticalAdvances: vertical ? [...fragment.shapedAdvances] : segment.verticalAdvances,
      };
    }),
    textTop: neutral.textTop,
    textLeft: neutral.textLeft,
    textHeight: neutral.textHeight,
    textWidth: neutral.textWidth,
    fontAscent: neutral.fontAscent,
    fontDescent: neutral.fontDescent,
    inputXOffsets: neutral.inputXOffsets == null ? undefined : [...neutral.inputXOffsets],
  };
  return { element, residualMatrix: multiplyTextAffine(inverse, paintMatrix) };
}

export function serializeTextPaintMatrix(matrix: CapturedTextPaintAffine): string {
  const clean = matrix.map((value) => Math.abs(value) < 1e-12 ? 0 : Number(value.toFixed(9)));
  return `matrix(${clean.join(" ")})`;
}

export function wrapAffineTextPaint(
  matrix: CapturedTextPaintAffine | undefined,
  markup: string,
): string {
  if (matrix == null || textAffineEquals(matrix, IDENTITY_TEXT_AFFINE)) return markup;
  return `<g transform="${serializeTextPaintMatrix(matrix)}">${markup}</g>`;
}
