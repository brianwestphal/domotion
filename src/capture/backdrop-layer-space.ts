/**
 * Blink hands Skia the prior parent device as the backdrop source, then maps
 * that source into the target layer with the relative transform between the
 * two devices.  A Chromium crop taken after that mapping is already in final
 * viewport space.  These helpers recover the affine neutral-box -> live-quad
 * mapping and its inverse so the SVG renderer can cancel only its surrounding
 * transform for that one raster while leaving the target's vector paint in
 * the normal local coordinate system.
 */

export type BackdropAffine = [number, number, number, number, number, number];
export type BackdropQuad = [number, number, number, number, number, number, number, number];

export interface BackdropLayerMapping {
  forward: BackdropAffine;
  inverse: BackdropAffine;
  bounds: { x: number; y: number; width: number; height: number };
}

export function invertBackdropAffine(matrix: BackdropAffine): BackdropAffine | null {
  const [a, b, c, d, e, f] = matrix;
  const determinant = a * d - b * c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) return null;
  return [
    d / determinant,
    -b / determinant,
    -c / determinant,
    a / determinant,
    (c * f - d * e) / determinant,
    (b * e - a * f) / determinant,
  ];
}

/** Solve an affine map from a neutral axis-aligned border box to a CDP quad. */
export function backdropLayerMapping(
  neutral: { x: number; y: number; width: number; height: number },
  live: BackdropQuad,
): BackdropLayerMapping | null {
  if (!(neutral.width > 0 && neutral.height > 0) || !live.every(Number.isFinite)) return null;
  const a = (live[2] - live[0]) / neutral.width;
  const b = (live[3] - live[1]) / neutral.width;
  const c = (live[6] - live[0]) / neutral.height;
  const d = (live[7] - live[1]) / neutral.height;
  const e = live[0] - a * neutral.x - c * neutral.y;
  const f = live[1] - b * neutral.x - d * neutral.y;
  const forward: BackdropAffine = [a, b, c, d, e, f];
  const inverse = invertBackdropAffine(forward);
  if (inverse == null) return null;
  const xs = [live[0], live[2], live[4], live[6]];
  const ys = [live[1], live[3], live[5], live[7]];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    forward,
    inverse,
    bounds: {
      x,
      y,
      width: Math.max(...xs) - x,
      height: Math.max(...ys) - y,
    },
  };
}
