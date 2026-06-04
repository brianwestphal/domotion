/**
 * Shared frame-timeline math for the animator and the `animate` CLI. The
 * "cut → 0, else the transition's duration, else the default" rule and the
 * default transition length lived in BOTH `animator.ts` (as `transitionDuration`
 * + `DEFAULT_TRANSITION_MS`) and `cli/animate.ts` (open-coded with a literal
 * `300` in three places) — exactly the kind of copy that drifts. Both now share
 * these so the scene clock advances identically wherever it's computed.
 */

/** Default transition length (ms) when a frame specifies no transition — the
 *  legacy crossfade duration. */
export const DEFAULT_TRANSITION_MS = 300;

/** The minimal frame shape this math needs — satisfied by both the animator's
 *  `AnimationFrame` and the CLI's parsed frame config. */
export interface TimelineFrame {
  duration: number;
  transition?: { type: string; duration: number } | null;
}

/** Effective transition duration for a frame. `cut` is always 0 (the type means
 *  "instant", so any input duration is meaningless); no transition → the
 *  default. */
export function transitionDurationMs(f: TimelineFrame): number {
  if (f.transition == null) return DEFAULT_TRANSITION_MS;
  if (f.transition.type === "cut") return 0;
  return f.transition.duration;
}

/** How far the scene clock advances across one frame: its hold duration plus its
 *  outgoing transition. The unit of every frame-timeline accumulation. */
export function frameAdvanceMs(f: TimelineFrame): number {
  return f.duration + transitionDurationMs(f);
}
