/**
 * Convert a CSS computed transform string to an SVG `transform` attribute
 * value, composed around (originX, originY) so the transform pivots there
 * (matches CSS's transform-origin semantics). Returns "" when the transform
 * is none or unparseable. See SK-1134.
 *
 * Chrome's getComputedStyle.transform always resolves to either
 * `matrix(a,b,c,d,e,f)` (2D) or `matrix3d(m11,m12,…m44)` (3D), so we don't
 * need to handle each named CSS function — just the matrix forms.
 *
 * `matrix3d()` is projected onto the z=0 plane the way Skia flattens a 4x4
 * for 2D paint: `SkM44::asM33()` (Skia ebf5052 `include/core/SkM44.h:409`,
 * unchanged in the 62efacd3 revision Chromium's DEPS pins) keeps m11, m12,
 * m14, m21, m22, m24, m41, m42 and m44 and drops only the z row and column;
 * `SkMatrix::mapPointPerspective` then divides x and y by the w term
 * `m14·x + m24·y + m44`. That projection is an SVG affine exactly when
 * m14 = m24 = 0 (w is then the constant m44, divided out below). With a
 * perspective term the paint is a trapezoid no `matrix(a b c d e f)` can
 * express, so this returns "" for it instead of selecting six entries —
 * callers use `isProjectiveCssTransform` to fail closed (see doc 162).
 */

/** Decimal places for emitted SVG coordinates (translate/origin) vs. the matrix scale/rotation terms (which need more to avoid visible drift). */
const COORD_PRECISION = 2;
const MATRIX_PRECISION = 5;

export function cssTransformToSvg(transform: string | undefined, originX: number, originY: number): string {
  if (transform == null || transform === "" || transform === "none") return "";
  const m2 =
    /^matrix\(\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)\s*\)$/.exec(
      transform,
    );
  let a = 1,
    b = 0,
    c = 0,
    d = 1,
    e = 0,
    f = 0;
  if (m2 != null) {
    a = parseFloat(m2[1]);
    b = parseFloat(m2[2]);
    c = parseFloat(m2[3]);
    d = parseFloat(m2[4]);
    e = parseFloat(m2[5]);
    f = parseFloat(m2[6]);
  } else {
    const m3 = /^matrix3d\(([^)]+)\)$/.exec(transform);
    if (m3 == null) return "";
    const parts = m3[1].split(",").map((s) => parseFloat(s.trim()));
    if (parts.length !== 16 || parts.some((n) => !isFinite(n))) return "";
    const affine = matrix3dPlanarAffine(parts);
    if (affine == null) return "";
    ({ a, b, c, d, e, f } = affine);
  }
  // Identity short-circuit: don't emit a no-op transform.
  if (a === 1 && b === 0 && c === 0 && d === 1 && e === 0 && f === 0) return "";
  // Compose around (originX, originY) so the rotate/scale pivots at the CSS
  // origin: SVG `translate(ox,oy) matrix(...) translate(-ox,-oy)`. When the
  // CSS matrix has a translation component (e, f), that already shifts; the
  // outer translate-origin pair makes the rotate/scale pivot correct.
  const ox = Number(originX.toFixed(COORD_PRECISION));
  const oy = Number(originY.toFixed(COORD_PRECISION));
  const matrixStr = `matrix(${Number(a.toFixed(MATRIX_PRECISION))} ${Number(b.toFixed(MATRIX_PRECISION))} ${Number(c.toFixed(MATRIX_PRECISION))} ${Number(d.toFixed(MATRIX_PRECISION))} ${Number(e.toFixed(COORD_PRECISION))} ${Number(f.toFixed(COORD_PRECISION))})`;
  if (ox === 0 && oy === 0) return matrixStr;
  return `translate(${ox} ${oy}) ${matrixStr} translate(${-ox} ${-oy})`;
}

/**
 * The exact SVG affine of a column-major CSS `matrix3d` applied to z=0
 * content, or null when none exists: a perspective term (m14 or m24 non-zero)
 * makes w vary across the plane, and m44 = 0 sends every point to infinity.
 * See `cssTransformToSvg` for the Skia `asM33()` derivation.
 */
function matrix3dPlanarAffine(
  parts: readonly number[],
): { a: number; b: number; c: number; d: number; e: number; f: number } | null {
  // Column-major: m11..m14, m21..m24, m31..m34, m41..m44.
  const m14 = parts[3];
  const m24 = parts[7];
  const m44 = parts[15];
  if (m14 !== 0 || m24 !== 0 || m44 === 0) return null;
  return {
    a: parts[0] / m44,
    b: parts[1] / m44,
    c: parts[4] / m44,
    d: parts[5] / m44,
    e: parts[12] / m44,
    f: parts[13] / m44,
  };
}

/**
 * True when `transform` is a well-formed computed `matrix3d()` whose z=0
 * projection is not affine (a perspective term, or m44 = 0). Such a transform
 * needs a Chromium-owned raster (`transformSubtreeRaster`); without one the
 * renderer must not paint a guessed affine.
 */
export function isProjectiveCssTransform(transform: string | undefined): boolean {
  if (transform == null) return false;
  const m3 = /^matrix3d\(([^)]+)\)$/.exec(transform);
  if (m3 == null) return false;
  const parts = m3[1].split(",").map((s) => parseFloat(s.trim()));
  if (parts.length !== 16 || parts.some((n) => !isFinite(n))) return false;
  return matrix3dPlanarAffine(parts) == null;
}
