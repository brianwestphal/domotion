/**
 * `contentBox(page, selector, { at, dx, dy })` — DM-1133.
 *
 * The padding-inset *content* box of an element on a live Playwright page, in
 * viewport coordinates. `getBoundingClientRect()` returns the BORDER box, but
 * imperative scripting-API callers building typing overlays need where text
 * actually starts inside a padded field (`<input>` / `<textarea>`), i.e. inset
 * by the element's border + padding. Every such caller otherwise re-derives
 * this with an inline `page.evaluate` that subtracts `getComputedStyle` padding;
 * this is the one-liner that replaces it.
 *
 * The optional `at` (default `"top-left"`) picks a named corner / edge / center
 * of the content box — the same vocabulary as the declarative overlay `anchor`
 * — and `dx` / `dy` nudge from it. The result carries both the full content box
 * (`x` / `y` / `width` / `height`) and the resolved `at` point, so a caller can
 * use either.
 *
 * This is the minimal, lowest-commitment slice of the overlay-resolution
 * primitive (DM-1132 builds the selector→resolved-overlay resolver on top).
 */

import type { Page } from "@playwright/test";

/** Named corner / edge / center of a box — mirrors the overlay `anchor.at` vocabulary. */
export type BoxAnchor =
  | "top-left" | "top" | "top-right"
  | "left" | "center" | "right"
  | "bottom-left" | "bottom" | "bottom-right";

export interface ContentBoxOptions {
  /** Which corner / edge / center of the content box to resolve as the `at` point. Default `"top-left"`. */
  at?: BoxAnchor;
  /** Horizontal nudge applied to the resolved `at` point (px). Default 0. */
  dx?: number;
  /** Vertical nudge applied to the resolved `at` point (px). Default 0. */
  dy?: number;
}

export interface ContentBox {
  /** Content-box top-left + size, viewport coordinates (border + padding removed). */
  x: number;
  y: number;
  width: number;
  height: number;
  /** The point at `opts.at` (default `"top-left"`) plus the `dx` / `dy` nudge. */
  at: [number, number];
}

/** Plain content-box rect (no resolved anchor point) — the page-measured part. */
type Rect = { x: number; y: number; width: number; height: number };

/**
 * Resolve a named anchor point on a box, with an optional dx/dy nudge. Pure +
 * exported so the corner/edge math is unit-testable without a browser.
 */
export function boxAnchorPoint(box: Rect, at: BoxAnchor = "top-left", dx = 0, dy = 0): [number, number] {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const right = box.x + box.width;
  const bottom = box.y + box.height;
  let px: number;
  let py: number;
  switch (at) {
    case "top":          px = cx;     py = box.y;  break;
    case "top-right":    px = right;  py = box.y;  break;
    case "left":         px = box.x;  py = cy;     break;
    case "center":       px = cx;     py = cy;     break;
    case "right":        px = right;  py = cy;     break;
    case "bottom-left":  px = box.x;  py = bottom; break;
    case "bottom":       px = cx;     py = bottom; break;
    case "bottom-right": px = right;  py = bottom; break;
    case "top-left":
    default:             px = box.x;  py = box.y;  break;
  }
  return [px + dx, py + dy];
}

/**
 * Measure the padding-inset content box of `selector` on `page`. Throws if the
 * selector matches no element (fail fast — a silently-missing element usually
 * means the script is subtly wrong, matching the declarative anchor's policy).
 */
export async function contentBox(page: Page, selector: string, opts: ContentBoxOptions = {}): Promise<ContentBox> {
  const rect = await page.evaluate((sel: string): Rect | null => {
    const el = document.querySelector(sel);
    if (el == null) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    // Inline `parseFloat || 0` (no inner helper function) so the serialized
    // evaluate body stays self-contained — a named inner function gets an
    // esbuild `__name` reference that isn't defined in the page context.
    const bl = parseFloat(cs.borderLeftWidth) || 0, br = parseFloat(cs.borderRightWidth) || 0;
    const bt = parseFloat(cs.borderTopWidth) || 0, bb = parseFloat(cs.borderBottomWidth) || 0;
    const pl = parseFloat(cs.paddingLeft) || 0, pr = parseFloat(cs.paddingRight) || 0;
    const pt = parseFloat(cs.paddingTop) || 0, pb = parseFloat(cs.paddingBottom) || 0;
    return {
      x: r.x + bl + pl,
      y: r.y + bt + pt,
      width: Math.max(0, r.width - bl - br - pl - pr),
      height: Math.max(0, r.height - bt - bb - pt - pb),
    };
  }, selector);
  if (rect == null) throw new Error(`contentBox: selector "${selector}" matched no element`);
  return { ...rect, at: boxAnchorPoint(rect, opts.at ?? "top-left", opts.dx ?? 0, opts.dy ?? 0) };
}
