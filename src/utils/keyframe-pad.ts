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

/**
 * DM-1511: Firefox composites a `visibility` animation off the main-thread /
 * opacity clock. At a step-end frame hand-off it can drop the OUTGOING frame's
 * paint a few compositor frames BEFORE the incoming frame starts painting,
 * flashing the transparent page-through gap for ~30-70ms — the "hard flash to
 * white/transparent at cut points" bug. Chromium and Safari keep the two in
 * lock-step, so a sub-millisecond overlap is enough there; Firefox is not.
 *
 * The fix is to drive the visual cut with `opacity` alone (Firefox composites
 * that correctly, and the tight `cull` overlap already guarantees a seamless
 * hand-off) and use `visibility` ONLY as the paint-cull gate (DM-599), with its
 * visible window padded WIDE — a fixed wall-clock margin on each side — so
 * adjacent frames' paint windows overlap well past any compositor slop. The
 * frame is `opacity:0` outside its true window, so the wide visibility window is
 * never itself visible; it only means a frame is *paintable* a little early and
 * a little late, which is harmless.
 *
 * Expressed as wall-clock (not a fixed %) so the overlap always beats the
 * compositor slop, which is a handful of vsync frames regardless of how long the
 * scene is. 150 ms is ~2x the largest gap observed (~70 ms).
 */
export const VISIBILITY_CULL_OVERLAP_MS = 150;

/** `VISIBILITY_CULL_OVERLAP_MS` as a percentage of a scene `totalMs` long. */
export function cullOverlapPct(totalMs: number): number {
  return totalMs > 0 ? (VISIBILITY_CULL_OVERLAP_MS / totalMs) * 100 : 0;
}
