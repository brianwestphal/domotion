/**
 * Keyframe-boundary pads. CSS `@keyframes` that snap with `step-end` (or that
 * bookend a slide/visibility window) nudge a stop just OFF an exact percentage
 * so the adjacent keyframe owns that instant — otherwise the two stops collide
 * on the same tick and the browser's tie-break is unstable. The pad is a tiny
 * epsilon, clamped to the legal [0, 100] range, printed at the same precision as
 * the surrounding keyframe percentages.
 *
 * Three epsilon sizes are in use, matched to that print precision; naming them
 * keeps the magic numbers consistent across the animator, the scroll composer,
 * and viewBox culling.
 */
export const KEYFRAME_EPSILON = {
  /** Slide transitions (push-left / scroll), printed at 2 decimals. */
  slide: 0.1,
  /** Display / fade-window snaps, printed at 2–3 decimals. */
  display: 0.01,
  /** Cull / visibility windows, printed at 3 decimals. */
  cull: 0.001,
} as const;

/** Percentage nudged DOWN by `epsilon` (floored at 0), printed at `precision`. */
export function padBefore(pct: number, epsilon: number, precision: number): string {
  return Math.max(0, pct - epsilon).toFixed(precision);
}

/** Percentage nudged UP by `epsilon` (capped at 100), printed at `precision`. */
export function padAfter(pct: number, epsilon: number, precision: number): string {
  return Math.min(100, pct + epsilon).toFixed(precision);
}
