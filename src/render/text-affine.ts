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
  if (el.projectiveTransform != null) return null;
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
  const paintMatrix = onePaintMatrix(geometry);
  if (paintMatrix == null) return { element: el, failureReason: "text fragments do not share one affine paint plane" };
  const inverse = emittedCtm == null ? null : invertTextAffine(emittedCtm);
  if (inverse == null) return { element: el, failureReason: "emitted text ancestor matrix is singular" };
  const fragmentsBySegment = new Map(geometry.fragments.map((fragment) => [fragment.textSegmentIndex, fragment]));
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
      return {
        ...segment,
        baseline: fragment.baseline,
        inlineOffset: fragment.inlineOffset,
        fontAscent: fragment.baseline - (vertical ? segment.x : segment.y),
        xOffsets: vertical ? segment.xOffsets : [...fragment.shapedOrigins],
        xAdvances: vertical ? segment.xAdvances : [...fragment.shapedAdvances],
        yOffsets: vertical ? [...fragment.shapedOrigins] : segment.yOffsets,
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
