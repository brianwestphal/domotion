/**
 * A two-dimensional matrix in the order exposed by SVGMatrix / DOMMatrix.
 *
 * DM-2473 keeps this helper DOM-free so the matrix correlation and
 * serialization contract can be unit-tested independently of Chromium. Blink
 * has already resolved the SVG transform reference box, origin (including z),
 * independent transform properties, motion path, zoom, and 3D flattening when
 * it exposes the element CTM. Capture only changes coordinate spaces here; it
 * never reconstructs those style decisions.
 */
export interface SvgAffineMatrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export interface SvgAffineFreeze {
  /** Blink-used mapping from the element coordinate system to its SVG parent. */
  usedLocal: SvgAffineMatrix;
  /** Intrinsic local mapping left after transform properties are neutralized. */
  neutralLocal: SvgAffineMatrix;
  /** Matrix to serialize once ahead of neutralLocal in SVG transform order. */
  frozen: SvgAffineMatrix;
}

export function isFiniteSvgAffine(matrix: SvgAffineMatrix | null | undefined): matrix is SvgAffineMatrix {
  return matrix != null
    && Number.isFinite(matrix.a)
    && Number.isFinite(matrix.b)
    && Number.isFinite(matrix.c)
    && Number.isFinite(matrix.d)
    && Number.isFinite(matrix.e)
    && Number.isFinite(matrix.f);
}

export function multiplySvgAffine(left: SvgAffineMatrix, right: SvgAffineMatrix): SvgAffineMatrix {
  return {
    a: left.a * right.a + left.c * right.b,
    b: left.b * right.a + left.d * right.b,
    c: left.a * right.c + left.c * right.d,
    d: left.b * right.c + left.d * right.d,
    e: left.a * right.e + left.c * right.f + left.e,
    f: left.b * right.e + left.d * right.f + left.f,
  };
}

export function invertSvgAffine(matrix: SvgAffineMatrix): SvgAffineMatrix | null {
  if (!isFiniteSvgAffine(matrix)) return null;
  const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
  // A zero determinant is the SVG singular boundary. Do not introduce an
  // epsilon that silently classifies a real, very-small authored scale as
  // singular; non-finite inversion below still fails closed.
  if (!Number.isFinite(determinant) || determinant === 0) return null;
  const inverse = {
    a: matrix.d / determinant,
    b: -matrix.b / determinant,
    c: -matrix.c / determinant,
    d: matrix.a / determinant,
    e: (matrix.c * matrix.f - matrix.d * matrix.e) / determinant,
    f: (matrix.b * matrix.e - matrix.a * matrix.f) / determinant,
  };
  return isFiniteSvgAffine(inverse) ? inverse : null;
}

/**
 * Correlate two browser-owned CTMs with a shared parent CTM.
 *
 * `usedCtm` is the sampled source mapping. `neutralCtm` is measured from a
 * sibling probe with only the element's transform contributors neutralized.
 * Most graphics have an identity neutral local mapping. A nested `<svg>` does
 * not: x/y plus viewBox/preserveAspectRatio remain intrinsic. SVG applies its
 * transform before that viewport mapping, so the serialized owner is
 * `usedLocal * inverse(neutralLocal)`, not `usedLocal` itself.
 */
export function deriveSvgAffineFreeze(
  usedCtm: SvgAffineMatrix,
  parentCtm: SvgAffineMatrix,
  neutralCtm: SvgAffineMatrix,
): SvgAffineFreeze | null {
  if (!isFiniteSvgAffine(usedCtm) || !isFiniteSvgAffine(parentCtm) || !isFiniteSvgAffine(neutralCtm)) {
    return null;
  }
  const parentInverse = invertSvgAffine(parentCtm);
  if (parentInverse == null) return null;
  const usedLocal = multiplySvgAffine(parentInverse, usedCtm);
  const neutralLocal = multiplySvgAffine(parentInverse, neutralCtm);
  const neutralInverse = invertSvgAffine(neutralLocal);
  if (neutralInverse == null) return null;
  const frozen = multiplySvgAffine(usedLocal, neutralInverse);
  // The ticket's singular boundary is explicit: a zero-area used mapping is
  // not eligible for the vector clone, even if its current paint is empty.
  if (invertSvgAffine(usedLocal) == null || invertSvgAffine(frozen) == null) return null;
  return { usedLocal, neutralLocal, frozen };
}

function serializeSvgNumber(value: number): string {
  // String(number) is ECMAScript's shortest round-trippable representation.
  // Normalizing negative zero avoids a semantically meaningless source of
  // unstable markup while retaining every other IEEE-754 value exactly.
  return Object.is(value, -0) ? "0" : String(value);
}

export function serializeSvgAffine(matrix: SvgAffineMatrix): string | null {
  if (!isFiniteSvgAffine(matrix)) return null;
  return `matrix(${serializeSvgNumber(matrix.a)} ${serializeSvgNumber(matrix.b)} ${serializeSvgNumber(matrix.c)} ${serializeSvgNumber(matrix.d)} ${serializeSvgNumber(matrix.e)} ${serializeSvgNumber(matrix.f)})`;
}

export function svgAffineMaxPointError(
  left: SvgAffineMatrix,
  right: SvgAffineMatrix,
  points: ReadonlyArray<readonly [number, number]> = [[0, 0], [1, 0], [0, 1]],
): number {
  if (!isFiniteSvgAffine(left) || !isFiniteSvgAffine(right)) return Number.POSITIVE_INFINITY;
  let max = 0;
  for (const [x, y] of points) {
    const lx = left.a * x + left.c * y + left.e;
    const ly = left.b * x + left.d * y + left.f;
    const rx = right.a * x + right.c * y + right.e;
    const ry = right.b * x + right.d * y + right.f;
    max = Math.max(max, Math.hypot(lx - rx, ly - ry));
  }
  return max;
}
