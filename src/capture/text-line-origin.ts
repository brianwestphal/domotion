/**
 * Source-transcribed Blink line-relative text origin construction.
 *
 * Pinned Chromium revision: 7d859f271cbda744098ac69f44978d4edfa62be3
 * - PhysicalBoxRect: core/paint/text_fragment_painter.cc:62-87
 * - integer primary ascent + LineRelativeOffset: same file:506-529
 * - writing transform: core/paint/line_relative_rect.cc:19-75
 * - later transform origin: core/style/computed_style.cc:1415-1489
 */

import type {
  CapturedTextPaintAffine,
  CapturedTextPaintLineOrigin,
  CapturedTextPaintPoint,
} from "./types.js";

export type CapturedTextWritingMode =
  | "horizontal-tb"
  | "vertical-rl"
  | "vertical-lr"
  | "sideways-rl"
  | "sideways-lr";

export const TEXT_LINE_ORIGIN_CHROMIUM_REVISION =
  "7d859f271cbda744098ac69f44978d4edfa62be3" as const;

export const TEXT_LINE_ORIGIN_PROVENANCE = {
  chromiumRevision: TEXT_LINE_ORIGIN_CHROMIUM_REVISION,
  physicalBox: "core/paint/text_fragment_painter.cc:62-87",
  primaryFontAscent: "core/paint/text_fragment_painter.cc:506-529",
  writingModeRotation: "core/paint/line_relative_rect.cc:19-75",
  transformOrigin: "core/style/computed_style.cc:1415-1489",
  decomposition: "normalized-neutral-fragment-top",
} as const;

const IDENTITY: CapturedTextPaintAffine = [1, 0, 0, 1, 0, 0];

export function asCapturedTextWritingMode(value: string): CapturedTextWritingMode | null {
  switch (value) {
    case "horizontal-tb":
    case "vertical-rl":
    case "vertical-lr":
    case "sideways-rl":
    case "sideways-lr":
      return value;
    default:
      return null;
  }
}

export function mapTextLineOriginPoint(
  matrix: CapturedTextPaintAffine,
  point: CapturedTextPaintPoint,
): CapturedTextPaintPoint {
  return {
    x: matrix[0] * point.x + matrix[2] * point.y + matrix[4],
    y: matrix[1] * point.x + matrix[3] * point.y + matrix[5],
  };
}

/** Blink `LineRelativeRect::ComputeRelativeToPhysicalTransform()`. */
export function textLineOriginWritingModeRotation(
  left: number,
  top: number,
  width: number,
  height: number,
  writingMode: CapturedTextWritingMode,
): CapturedTextPaintAffine {
  if (writingMode === "horizontal-tb") return [...IDENTITY];
  if (writingMode === "sideways-lr") {
    return [0, -1, 1, 0, left - top, left + top + height];
  }
  // vertical-rl, vertical-lr, and sideways-rl share Blink's clockwise map.
  return [0, 1, -1, 0, left + top + width, top - left];
}

export interface TextLineOriginInput {
  fragmentLeft: number;
  fragmentTop: number;
  fragmentWidth: number;
  fragmentHeight: number;
  primaryFontAscent: number;
  writingMode: CapturedTextWritingMode;
  effectiveZoom: number;
}

/**
 * Build the neutral-plane record once, before the later CSS affine mapping.
 *
 * CDP exposes the finished neutral fragment top, not Blink's private
 * `paint_offset` and `parent_offset` operands. We therefore retain the exact
 * painter result as an equivalent normalized pair: LayoutUnit-compatible
 * rounded integer top plus its untouched fractional fragment delta. This
 * preserves the source operation without pretending the private operands were
 * observable.
 */
export function buildCapturedTextLineOrigin(
  input: TextLineOriginInput,
): CapturedTextPaintLineOrigin | null {
  const values = [
    input.fragmentLeft,
    input.fragmentTop,
    input.fragmentWidth,
    input.fragmentHeight,
    input.primaryFontAscent,
    input.effectiveZoom,
  ];
  if (!values.every(Number.isFinite) || input.fragmentWidth < 0 || input.fragmentHeight < 0
      || input.effectiveZoom <= 0) return null;
  const primaryFontIntegerAscent = Math.round(input.primaryFontAscent);
  const roundedContainingPaintOffsetTop = Math.round(input.fragmentTop);
  const fragmentRelativeTop = input.fragmentTop - roundedContainingPaintOffsetTop;
  const physicalTop = roundedContainingPaintOffsetTop + fragmentRelativeTop;
  const lineRelativeTextOrigin = {
    lineLeft: input.fragmentLeft,
    lineOver: physicalTop + primaryFontIntegerAscent,
  };
  const writingModeRotation = textLineOriginWritingModeRotation(
    input.fragmentLeft,
    physicalTop,
    input.fragmentWidth,
    input.fragmentHeight,
    input.writingMode,
  );
  const physicalBaselinePoint = mapTextLineOriginPoint(writingModeRotation, {
    x: lineRelativeTextOrigin.lineLeft,
    y: lineRelativeTextOrigin.lineOver,
  });
  return {
    source: "blink-text-fragment-line-origin-v1",
    space: "pre-css-transform-viewport",
    roundedContainingPaintOffsetTop,
    fragmentRelativeTop,
    primaryFontIntegerAscent,
    lineRelativeTextOrigin,
    writingModeRotation,
    physicalBaselinePoint,
    effectiveZoom: input.effectiveZoom,
    provenance: { ...TEXT_LINE_ORIGIN_PROVENANCE },
  };
}

export function capturedTextLineOriginErrors(
  record: CapturedTextPaintLineOrigin,
  input: Omit<TextLineOriginInput, "primaryFontAscent" | "effectiveZoom" | "writingMode"> & {
    writingMode: string;
    effectiveZoom?: number;
  },
  epsilon = 1e-7,
): string[] {
  const errors: string[] = [];
  const mode = asCapturedTextWritingMode(input.writingMode);
  if (record.source !== "blink-text-fragment-line-origin-v1"
      || record.space !== "pre-css-transform-viewport") errors.push("line-origin schema provenance is unavailable");
  if (record.provenance.chromiumRevision !== TEXT_LINE_ORIGIN_CHROMIUM_REVISION
      || record.provenance.decomposition !== "normalized-neutral-fragment-top") errors.push("line-origin Chromium provenance changed");
  if (!Number.isInteger(record.roundedContainingPaintOffsetTop)) errors.push("containing paint offset was not integer-rounded");
  if (!Number.isInteger(record.primaryFontIntegerAscent)) errors.push("primary-font ascent is not an integer");
  if (!(record.effectiveZoom > 0) || !Number.isFinite(record.effectiveZoom)) errors.push("effective zoom is invalid");
  if (input.effectiveZoom != null && Math.abs(record.effectiveZoom - input.effectiveZoom) > epsilon) errors.push("effective zoom changed planes");
  if (mode == null) return [...errors, "unsupported writing mode"];
  const physicalTop = record.roundedContainingPaintOffsetTop + record.fragmentRelativeTop;
  if (Math.abs(physicalTop - input.fragmentTop) > epsilon) errors.push("fragment-relative top changed");
  if (Math.abs(record.lineRelativeTextOrigin.lineLeft - input.fragmentLeft) > epsilon) errors.push("line-left origin changed");
  if (Math.abs(record.lineRelativeTextOrigin.lineOver - (physicalTop + record.primaryFontIntegerAscent)) > epsilon) errors.push("ascent was not applied in line-relative space");
  const expectedRotation = textLineOriginWritingModeRotation(
    input.fragmentLeft,
    physicalTop,
    input.fragmentWidth,
    input.fragmentHeight,
    mode,
  );
  if (expectedRotation.some((value, index) => Math.abs(value - record.writingModeRotation[index]) > epsilon)) errors.push("writing-mode rotation changed");
  const expectedPhysical = mapTextLineOriginPoint(record.writingModeRotation, {
    x: record.lineRelativeTextOrigin.lineLeft,
    y: record.lineRelativeTextOrigin.lineOver,
  });
  if (Math.hypot(
    expectedPhysical.x - record.physicalBaselinePoint.x,
    expectedPhysical.y - record.physicalBaselinePoint.y,
  ) > epsilon) errors.push("decoded physical baseline changed");
  return errors;
}
