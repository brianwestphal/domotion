/**
 * Source-owned identity adjudicator for the native `<text>` arm of the
 * paths/native raster floor (DM-2499).
 *
 * CDP's `postScriptName` is deliberately NOT an identity input.  On Windows,
 * DirectWrite exposes weight/stretch/style presentation names (for example
 * `Roboto`, `Roboto-Medium`, or `Roboto-ExtraBold`) for one variable face.
 * The durable identity is the unique requested CSS family plus custom-font
 * provenance, followed by the independently authenticated source/face/axes
 * and production glyph/outline facts.
 */

export interface PathsNativeIdentityGlyph {
  gid: number;
  cluster: number;
  advanceX: number;
  advanceY: number;
  offsetX: number;
  offsetY: number;
  outlineSha256: string;
  outlineCommandCount: number;
}

export interface PathsNativeHelperFaceEvidence {
  /** Informational name-ID-6 metadata; never compared with CDP's display name. */
  postscriptDisplayName: string;
  sourceSha256: string;
  faceIndex: number;
  resolvedAxes: Record<string, number>;
  helperSha256: string;
}

export interface PathsNativeFaceObservation {
  requestedFamily: string;
  computedFamily: string;
  fontFaceRuleFamily: string;
  fontFaceRuleCount: number;
  sourceSha256: string;
  computedVariationAxes: Record<string, number>;
  /** Informational platform/internal family metadata; not an identity key. */
  paintedFamilyDisplayName: string;
  /** Informational backend presentation metadata; not an identity key. */
  postscriptDisplayName: string;
  isCustomFont: boolean;
  glyphCount: number;
  helper?: PathsNativeHelperFaceEvidence;
}

export interface PathsNativeFaceIdentityEvidence {
  platform: NodeJS.Platform;
  isVariable: boolean;
  expectedFamily: string;
  fingerprintHelperSha256?: string;
  expected: {
    sourceSha256: string;
    faceIndex: number;
    variationAxes: Record<string, number>;
    glyphs: PathsNativeIdentityGlyph[];
  };
  actual: {
    sourceSha256: string;
    faceIndex: number;
    variationAxes: Record<string, number>;
    glyphs: PathsNativeIdentityGlyph[];
  };
  native: PathsNativeFaceObservation;
}

const stable = (value: unknown): unknown => Array.isArray(value)
  ? value.map(stable)
  : value != null && typeof value === "object"
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, stable(entry)]))
    : value;

const equal = (a: unknown, b: unknown): boolean => JSON.stringify(stable(a)) === JSON.stringify(stable(b));

export type PathsNativeFaceIdentityBlocker =
  | "requested-family"
  | "computed-family"
  | "font-face-rule-count"
  | "font-face-rule-family"
  | "non-custom-font"
  | "glyph-count"
  | "native-source-bytes"
  | "native-variation-axes"
  | "source-bytes"
  | "face-index"
  | "variation-axes"
  | "glyph-outline-stream"
  | "missing-win32-variable-helper"
  | "helper-fingerprint"
  | "helper-source-bytes"
  | "helper-face-index"
  | "helper-variation-axes";

export function assessPathsNativeFaceIdentity(evidence: PathsNativeFaceIdentityEvidence): {
  pass: boolean;
  blockers: PathsNativeFaceIdentityBlocker[];
} {
  const { expected, actual, native } = evidence;
  const blockers: PathsNativeFaceIdentityBlocker[] = [];
  if (native.requestedFamily !== evidence.expectedFamily) blockers.push("requested-family");
  if (native.computedFamily !== evidence.expectedFamily) blockers.push("computed-family");
  if (native.fontFaceRuleCount !== 1) blockers.push("font-face-rule-count");
  if (native.fontFaceRuleFamily !== evidence.expectedFamily) blockers.push("font-face-rule-family");
  if (!native.isCustomFont) blockers.push("non-custom-font");
  if (native.glyphCount !== expected.glyphs.length) blockers.push("glyph-count");
  if (native.sourceSha256 !== expected.sourceSha256) blockers.push("native-source-bytes");
  if (!equal(native.computedVariationAxes, expected.variationAxes)) blockers.push("native-variation-axes");
  if (actual.sourceSha256 !== expected.sourceSha256) blockers.push("source-bytes");
  if (actual.faceIndex !== expected.faceIndex) blockers.push("face-index");
  if (!equal(actual.variationAxes, expected.variationAxes)) blockers.push("variation-axes");
  if (!equal(actual.glyphs, expected.glyphs)) blockers.push("glyph-outline-stream");

  if (evidence.platform === "win32" && evidence.isVariable) {
    const helper = native.helper;
    if (helper == null) {
      blockers.push("missing-win32-variable-helper");
    } else {
      if (evidence.fingerprintHelperSha256 == null
          || helper.helperSha256 !== evidence.fingerprintHelperSha256) blockers.push("helper-fingerprint");
      if (helper.sourceSha256 !== expected.sourceSha256) blockers.push("helper-source-bytes");
      if (helper.faceIndex !== expected.faceIndex) blockers.push("helper-face-index");
      if (!equal(helper.resolvedAxes, expected.variationAxes)) blockers.push("helper-variation-axes");
    }
  }
  return { pass: blockers.length === 0, blockers };
}

/** Source/cell-owned alias; never inferred from CDP platform display names. */
export function pathsRasterCssFamily(id: string): string {
  return `DomotionPathsRaster_${id.replace(/[^A-Za-z0-9_]/g, "_")}`;
}
