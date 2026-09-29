/**
 * The two review UIs (`src/review/client.tsx`, the single-fixture `svg-review` page, and
 * `tests/review-client.tsx`, the multi-card `demos:review` harness) each drive a fullscreen lightbox over
 * the same region overlay. Their surrounding controllers differ (one card vs many, signals vs plain
 * state), but two pieces were byte-for-byte the same and live here so they cannot drift.
 */

import type { OverlayHandle } from "./region-overlay.js";

/**
 * Toggle `.tall` on the lightbox so a taller-than-wide image scales to the viewport width and the
 * lightbox container scrolls vertically (DM-736). If the image has not loaded yet, wait for its first
 * load to learn the aspect ratio.
 */
export function applyLightboxAspect(lightbox: HTMLElement, img: HTMLImageElement): void {
  const setAspect = (w: number, h: number): void => {
    lightbox.classList.toggle("tall", h > w);
  };
  if (img.naturalWidth > 0 && img.naturalHeight > 0) {
    setAspect(img.naturalWidth, img.naturalHeight);
    return;
  }
  img.addEventListener("load", () => setAspect(img.naturalWidth, img.naturalHeight), { once: true });
}

export interface LightboxOverlayBinding {
  /** Attach the lightbox view to a card's overlay handle. A no-op when already attached to that same
   *  handle, so in-flight rectangles survive arrow-key navigation within one triplet. Switching to a
   *  different handle detaches the previous one first. */
  attach(handle: OverlayHandle): void;
  /** Detach the current view (idempotent). The overlay clears the SVG it painted. */
  detach(): void;
}

/**
 * Binds the lightbox `<img>` / `<svg>` pair to region overlays. The same overlay handle drives a card's
 * three thumbnails AND the lightbox image, so a rectangle drawn while zoomed in shows up on the
 * thumbnails after the lightbox closes (DM-976). `onClickThrough` runs when the user taps the image
 * without crossing the drag threshold (both UIs close the lightbox).
 */
export function createLightboxOverlayBinding(
  img: HTMLImageElement,
  svg: SVGSVGElement,
  onClickThrough: () => void,
): LightboxOverlayBinding {
  let attachedHandle: OverlayHandle | null = null;
  let detachView: (() => void) | null = null;
  const binding: LightboxOverlayBinding = {
    attach(handle) {
      if (attachedHandle === handle) return;
      binding.detach();
      detachView = handle.addView(img, svg, onClickThrough);
      attachedHandle = handle;
    },
    detach() {
      detachView?.();
      detachView = null;
      attachedHandle = null;
    },
  };
  return binding;
}
