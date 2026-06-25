/**
 * Snap a viewport-relative element rect to the absolute, integer-pixel clip
 * Playwright's `page.screenshot({ clip })` expects.
 *
 * Captured rects are in CSS px relative to the capture viewport's top-left, so
 * the viewport origin (`viewport.x` / `viewport.y`) is added back to get
 * absolute page coordinates. The bounds are snapped OUTWARD — floor the origin,
 * ceil the size, and clamp the size to a 1px minimum — so the element stays
 * fully contained (Playwright clips at integer boundaries and rejects zero-size
 * clips). The origin is clamped to >= 0 so a rect that starts off the top/left
 * of the page doesn't produce a negative clip.
 *
 * Extracted (DM-1371) from the identical idiom in the emoji raster pass, the
 * initial-letter probe, and the mask-fragment screenshot path.
 */
export function clipRectForScreenshot(
  rect: { x: number; y: number; width: number; height: number },
  viewport: { x: number; y: number },
): { x: number; y: number; width: number; height: number } {
  return {
    x: Math.max(0, Math.floor(rect.x + viewport.x)),
    y: Math.max(0, Math.floor(rect.y + viewport.y)),
    width: Math.max(1, Math.ceil(rect.width)),
    height: Math.max(1, Math.ceil(rect.height)),
  };
}
