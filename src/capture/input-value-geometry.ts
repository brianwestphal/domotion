/** Chromium-pierced geometry for the closed-UA-shadow input value text. */

export interface CapturedInputValueTextGeometry {
  source: "chromium-ua-shadow-text-quad-v1";
  hostWidth: number;
  hostHeight: number;
  textTopOffset: number;
  textHeight: number;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const QUAD_EPSILON = 0.05;

function axisAlignedRect(quads: readonly (readonly number[])[]): Rect | null {
  if (quads.length !== 1) return null;
  const q = quads[0];
  if (q.length !== 8 || !q.every(Number.isFinite)) return null;
  if (Math.abs(q[1] - q[3]) > QUAD_EPSILON
      || Math.abs(q[2] - q[4]) > QUAD_EPSILON
      || Math.abs(q[5] - q[7]) > QUAD_EPSILON
      || Math.abs(q[6] - q[0]) > QUAD_EPSILON) return null;
  const width = q[2] - q[0];
  const height = q[5] - q[1];
  if (!(width > 0) || !(height > 0)) return null;
  return { x: q[0], y: q[1], width, height };
}

/**
 * Convert one host border quad and one UA-shadow text FragmentItem quad into a
 * translation-invariant value-text offset. Scale/rotation are rejected later
 * by comparing the live host dimensions with this recorded border box.
 */
export function capturedInputValueTextGeometry(
  hostQuads: readonly (readonly number[])[],
  textQuads: readonly (readonly number[])[],
): CapturedInputValueTextGeometry | null {
  const host = axisAlignedRect(hostQuads);
  const text = axisAlignedRect(textQuads);
  if (host == null || text == null) return null;
  const textTopOffset = text.y - host.y;
  if (!Number.isFinite(textTopOffset)) return null;
  return {
    source: "chromium-ua-shadow-text-quad-v1",
    hostWidth: host.width,
    hostHeight: host.height,
    textTopOffset,
    textHeight: text.height,
  };
}
