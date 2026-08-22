/**
 * Partial native/closed-UA-shadow form-control decoration ownership.
 *
 * A complete effective appearance is handled by `nativeControlRaster`.  This
 * module classifies the narrower case where Blink has returned host box paint
 * to CSS but still paints a decoration either through ThemePainter or through
 * a closed UA-shadow child.  It contains no platform metrics or sampled glyph
 * geometry; Chromium supplies the actual pixels and layout rects later.
 *
 * Pinned Chromium 7d859f271cbda744098ac69f44978d4edfa62be3:
 * - theme_painter.cc / theme_painter_default.cc: menulist-button decoration,
 *   inner-spin-button, and searchfield-cancel-button dispatch.
 * - html/resources/html.css: temporal picker resource paint and the
 *   visibility/opacity rules for picker, cancel, and spin parts.
 */

import type { ControlDescriptor } from "./effective-appearance.js";
import { isWholeHostNativeAppearance } from "./effective-appearance.js";

export const NATIVE_CONTROL_DECORATION_KINDS = [
  "menulist-button-arrow",
  "calendar-picker-indicator",
  "search-cancel-button",
  "inner-spin-button",
] as const;

export type NativeControlDecorationKind = typeof NATIVE_CONTROL_DECORATION_KINDS[number];

const TEMPORAL_INPUT_TYPES = new Set([
  "date", "datetime-local", "month", "time", "week",
]);

/**
 * Return only the decoration owners which survive after the host stops being
 * a complete native surface. `base`/`base-select` deliberately remain in the
 * existing structural customizable-control route.
 */
export function nativeControlDecorationKinds(
  control: ControlDescriptor,
  effectiveAppearance: string | null,
): NativeControlDecorationKind[] {
  if (effectiveAppearance == null || isWholeHostNativeAppearance(effectiveAppearance)) return [];
  if (effectiveAppearance === "base" || effectiveAppearance === "base-select") return [];

  const tag = control.tag.toLowerCase();
  if (tag === "select") {
    return effectiveAppearance === "menulist-button" ? ["menulist-button-arrow"] : [];
  }
  if (tag !== "input") return [];

  const type = (control.type ?? "text").toLowerCase();
  if (type === "number") return ["inner-spin-button"];
  if (type === "search") return ["search-cancel-button"];
  if (TEMPORAL_INPUT_TYPES.has(type)) {
    // Current multiple-fields views expose the picker indicator as the paint
    // owner. Some historical UA sheets still mention inner-spin-button for
    // these types, but absence of that optional node is not a capture failure.
    return ["calendar-picker-indicator"];
  }
  return [];
}

export interface DecorationPartFingerprint {
  kind: NativeControlDecorationKind;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Reject a detached/relaid UA part instead of cropping stale coordinates. */
export function decorationFingerprintMatches(
  expected: DecorationPartFingerprint,
  actual: DecorationPartFingerprint,
  tolerance = 0.25,
): boolean {
  if (expected.kind !== actual.kind) return false;
  const numbers = [
    expected.x, expected.y, expected.width, expected.height,
    actual.x, actual.y, actual.width, actual.height,
  ];
  if (!numbers.every(Number.isFinite) || expected.width <= 0 || expected.height <= 0
      || actual.width <= 0 || actual.height <= 0) return false;
  return Math.abs(expected.x - actual.x) <= tolerance
    && Math.abs(expected.y - actual.y) <= tolerance
    && Math.abs(expected.width - actual.width) <= tolerance
    && Math.abs(expected.height - actual.height) <= tolerance;
}
