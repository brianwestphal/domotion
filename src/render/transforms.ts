/**
 * Convert a CSS computed transform string to an SVG `transform` attribute
 * value, composed around (originX, originY) so the transform pivots there
 * (matches CSS's transform-origin semantics). Returns "" when the transform
 * is none or unparseable. See SK-1134.
 *
 * Chrome's getComputedStyle.transform always resolves to either
 * `matrix(a,b,c,d,e,f)` (2D) or `matrix3d(m11,m12,…m44)` (3D), so we don't
 * need to handle each named CSS function — just the matrix forms. 3D is
 * downgraded to its 2D submatrix (m11, m12, m21, m22, m41, m42 → SVG matrix
 * a, b, c, d, e, f), which loses perspective/depth but preserves x/y rotate
 * and scale. SK-1135 tracks the warning emission for 3D.
 */

/** Decimal places for emitted SVG coordinates (translate/origin) vs. the matrix scale/rotation terms (which need more to avoid visible drift). */
const COORD_PRECISION = 2;
const MATRIX_PRECISION = 5;

export function cssTransformToSvg(transform: string | undefined, originX: number, originY: number): string {
  if (transform == null || transform === "" || transform === "none") return "";
  const m2 = /^matrix\(\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)\s*\)$/.exec(transform);
  let a = 1, b = 0, c = 0, d = 1, e = 0, f = 0;
  if (m2 != null) {
    a = parseFloat(m2[1]); b = parseFloat(m2[2]); c = parseFloat(m2[3]); d = parseFloat(m2[4]); e = parseFloat(m2[5]); f = parseFloat(m2[6]);
  } else {
    const m3 = /^matrix3d\(([^)]+)\)$/.exec(transform);
    if (m3 == null) return "";
    const parts = m3[1].split(",").map((s) => parseFloat(s.trim()));
    if (parts.length !== 16 || parts.some((n) => !isFinite(n))) return "";
    // CSS matrix3d is column-major: m11..m14, m21..m24, m31..m34, m41..m44.
    // The 2D submatrix is m11, m12, m21, m22, m41, m42 → a, b, c, d, e, f.
    a = parts[0]; b = parts[1]; c = parts[4]; d = parts[5]; e = parts[12]; f = parts[13];
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
