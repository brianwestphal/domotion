import { clearRasterTileCaches } from "../render/raster-tile-cache.js";
import { clearEmbeddedImageCaches } from "./embed.js";

/**
 * Reset the process-global caches that belong to one capture generation: the
 * embedded-image data URIs (and their resized variants) and the raster tiles
 * capture paints for conic / advanced gradients.
 *
 * Call it where a generation STARTS — beside `clearWebfonts()`, before the page is
 * captured. Never between a capture and its render: the render reads what the
 * capture wrote. In a long-lived host (Studio, review server) this is what bounds
 * the caches and stops the first document's tiles pinning every later document.
 */
export function clearCaptureGenerationCaches(): void {
  clearEmbeddedImageCaches();
  clearRasterTileCaches();
}
