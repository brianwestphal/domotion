/**
 * Process-global Chromium/CPU raster tile caches for gradient backgrounds that
 * have no native SVG form (conic and the "advanced" gradient set).
 *
 * Each maps a CSS layer string to `${tileW}x${tileH}` → PNG data URI. Capture
 * fills them (from the live page, or a CPU approximation when no page is
 * available) and the renderer reads them, so a cache must live from the START of
 * a capture generation until its render finishes. It is therefore cleared at the
 * same generation boundaries that reset the webfont registry — never between a
 * capture and its render, which would erase the tiles the render is about to read.
 *
 * Kept in its own module so the two rasterizers and the renderer can all import
 * it without importing each other.
 */

/** @internal Conic-gradient tiles, see `rasterizeConicGradients`. */
export const _conicTileCache = new Map<string, Map<string, string>>();

/** @internal Non-conic advanced-gradient tiles, see `rasterizeAdvancedGradients`. */
export const _advancedGradientTileCache = new Map<string, Map<string, string>>();

/**
 * Drop every raster tile. Both caches otherwise grow for the life of the process
 * and, because a rasterizer never overwrites an existing key, would pin the first
 * document's tile (even a CPU approximation) against every later document.
 */
export function clearRasterTileCaches(): void {
  _conicTileCache.clear();
  _advancedGradientTileCache.clear();
}
