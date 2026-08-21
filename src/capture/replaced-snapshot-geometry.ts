/**
 * Geometry shared by the replaced-element raster pass and its browser oracle.
 *
 * Blink keeps replaced content in its local content box, maps that box through
 * the transform tree, and only then intersects the clip tree. A screenshot is
 * a device-pixel image of a CSS-pixel clip. Keeping those spaces separate is
 * important: applying a clip delta from the mapped AABB to the local box is
 * only valid for a translation and stretches/rotates the sampled pixels for
 * every other transform.
 */

export interface CssRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** p1, p2, p3, p4 in Blink/DevTools clockwise order. */
export type CssQuad = [number, number, number, number, number, number, number, number];

export interface ReplacedScreenshotMapping {
  /** CSS-pixel clip passed to Chromium. */
  clip: CssRect;
  /** CSS-pixel destination in the captured SVG coordinate space. */
  output: CssRect;
}

const EPSILON = 1e-3;

export function axisAlignedQuadBounds(quad: CssQuad): CssRect | null {
  const [x1, y1, x2, y2, x3, y3, x4, y4] = quad;
  if (![x1, y1, x2, y2, x3, y3, x4, y4].every(Number.isFinite)) return null;
  // DOM.getBoxModel serializes the four LocalRectToAbsoluteQuad corners in
  // clockwise order. Once renderer-owned affine transforms are neutralized,
  // only Blink-baked translations/scales/zoom remain and the content quad must
  // be axis aligned. Rejecting a residual skew/projective quad prevents a
  // known-inexact AABB fallback from silently re-entering the pipeline.
  if (Math.abs(y1 - y2) > EPSILON
      || Math.abs(x2 - x3) > EPSILON
      || Math.abs(y3 - y4) > EPSILON
      || Math.abs(x4 - x1) > EPSILON) {
    return null;
  }
  const left = Math.min(x1, x2, x3, x4);
  const right = Math.max(x1, x2, x3, x4);
  const top = Math.min(y1, y2, y3, y4);
  const bottom = Math.max(y1, y2, y3, y4);
  if (right - left <= EPSILON || bottom - top <= EPSILON) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Translate every point without collapsing the quad to an AABB. */
export function translateQuad(quad: CssQuad, dx: number, dy: number): CssQuad {
  return [
    quad[0] + dx, quad[1] + dy,
    quad[2] + dx, quad[3] + dy,
    quad[4] + dx, quad[5] + dy,
    quad[6] + dx, quad[7] + dy,
  ];
}

/**
 * Map a screenshot of `sampledQuad` back onto `outputQuad`.
 *
 * The raster pass may translate an isolated target into the capture viewport
 * so Chromium can sample pixels that were off the page before an SVG-owned
 * rotate/skew brings them on-screen. The two quads therefore must differ by a
 * translation only. The screenshot clip is snapped outwards once, and the
 * same snapped margins are transferred to the output rect. This is the one
 * valid form of a translation delta; it never treats a transformed AABB delta
 * as a local-content delta.
 */
export function mapTranslatedQuadToScreenshot(
  outputQuad: CssQuad,
  sampledQuad: CssQuad,
  screenshotBounds: CssRect,
): ReplacedScreenshotMapping | null {
  const output = axisAlignedQuadBounds(outputQuad);
  const sampled = axisAlignedQuadBounds(sampledQuad);
  if (output == null || sampled == null) return null;
  if (Math.abs(output.width - sampled.width) > EPSILON
      || Math.abs(output.height - sampled.height) > EPSILON) {
    return null;
  }

  const boundsRight = screenshotBounds.x + screenshotBounds.width;
  const boundsBottom = screenshotBounds.y + screenshotBounds.height;
  const sampledRight = sampled.x + sampled.width;
  const sampledBottom = sampled.y + sampled.height;
  const visibleLeft = Math.max(sampled.x, screenshotBounds.x);
  const visibleTop = Math.max(sampled.y, screenshotBounds.y);
  const visibleRight = Math.min(sampledRight, boundsRight);
  const visibleBottom = Math.min(sampledBottom, boundsBottom);
  if (visibleRight <= visibleLeft || visibleBottom <= visibleTop) return null;

  const clipLeft = Math.max(screenshotBounds.x, Math.floor(visibleLeft));
  const clipTop = Math.max(screenshotBounds.y, Math.floor(visibleTop));
  const clipRight = Math.min(boundsRight, Math.ceil(visibleRight));
  const clipBottom = Math.min(boundsBottom, Math.ceil(visibleBottom));
  if (clipRight <= clipLeft || clipBottom <= clipTop) return null;

  const clip = {
    x: clipLeft,
    y: clipTop,
    width: clipRight - clipLeft,
    height: clipBottom - clipTop,
  };
  return {
    clip,
    output: {
      x: output.x + (clip.x - sampled.x),
      y: output.y + (clip.y - sampled.y),
      width: clip.width,
      height: clip.height,
    },
  };
}

export interface PixelCropMapping {
  crop: { left: number; top: number; width: number; height: number };
  output: CssRect;
}

/**
 * Convert a capture-local CSS rectangle to source-image pixels. The source PNG
 * may be DPR-scaled; deriving each axis from its actual dimensions avoids the
 * old assumption that one CSS pixel is one bitmap pixel.
 */
export function mapCssRectToSourcePixels(
  rect: CssRect,
  captureSize: { width: number; height: number },
  sourceSize: { width: number; height: number },
): PixelCropMapping | null {
  if (captureSize.width <= 0 || captureSize.height <= 0
      || sourceSize.width <= 0 || sourceSize.height <= 0
      || rect.width <= 0 || rect.height <= 0) return null;
  const scaleX = sourceSize.width / captureSize.width;
  const scaleY = sourceSize.height / captureSize.height;
  const left = Math.max(0, Math.floor(rect.x * scaleX));
  const top = Math.max(0, Math.floor(rect.y * scaleY));
  const right = Math.min(sourceSize.width, Math.ceil((rect.x + rect.width) * scaleX));
  const bottom = Math.min(sourceSize.height, Math.ceil((rect.y + rect.height) * scaleY));
  if (right <= left || bottom <= top) return null;
  return {
    crop: { left, top, width: right - left, height: bottom - top },
    output: {
      x: left / scaleX,
      y: top / scaleY,
      width: (right - left) / scaleX,
      height: (bottom - top) / scaleY,
    },
  };
}

