/** The on-demand real-world suite keeps its routine heavy-page scroll sample bounded. */
const SAMPLE_TRANSITIONS: Readonly<Record<string, number>> = { stripe: 4, resend: 1 };
const DEFAULT_JOB_TIMEOUT_MS = 6 * 60_000;
const FULL_SCROLL_BASE_MS = 2 * 60_000;
const FULL_SCROLL_MAX_MS = 60 * 60_000;

export interface RealWorldScrollPlan {
  extent: "sampled" | "full-depth";
  availableEndY: number;
  requestedEndY: number;
  plannedTransitions: number;
  jobTimeoutMs: number;
}

/**
 * A full-depth Stripe or Resend scroll is available on demand. The routine
 * sample still exercises initial ownership, motion, composition and per-chunk
 * raster comparison without making every real-world run wait for dozens of
 * expensive full-tree captures.
 */
export function planRealWorldScroll(
  site: string,
  viewportH: number,
  maxScrollY: number,
  fullScroll: boolean,
): RealWorldScrollPlan {
  const availableEndY = Math.max(0, maxScrollY);
  const sampleTransitions = SAMPLE_TRANSITIONS[site];
  const sampledEndY =
    sampleTransitions == null ? availableEndY : Math.min(availableEndY, viewportH * sampleTransitions);
  const extent = !fullScroll && sampledEndY < availableEndY ? "sampled" : "full-depth";
  const requestedEndY = extent === "sampled" ? sampledEndY : availableEndY;
  const plannedTransitions = Math.ceil(requestedEndY / viewportH);
  // Measured full-depth costs: Stripe about 20s per viewport transition;
  // Resend about 122s. Keep an honest bounded allowance for the opt-in full
  // sweep while routine samples retain the six-minute job watchdog.
  const fullChunkBudgetMs = site === "resend" ? 150_000 : 45_000;
  const jobTimeoutMs =
    fullScroll && sampleTransitions != null
      ? Math.min(
          FULL_SCROLL_MAX_MS,
          Math.max(DEFAULT_JOB_TIMEOUT_MS, FULL_SCROLL_BASE_MS + (plannedTransitions + 1) * fullChunkBudgetMs),
        )
      : DEFAULT_JOB_TIMEOUT_MS;
  return { extent, availableEndY, requestedEndY, plannedTransitions, jobTimeoutMs };
}

/** An infinite CSS animation wraps to its first frame at the exact cycle end. */
export function scrollChunkSeekTimeMs(segmentEndMs: number, cycleEndMs: number): number {
  return segmentEndMs >= cycleEndMs ? Math.max(0, cycleEndMs - Math.min(1, cycleEndMs / 2)) : segmentEndMs;
}
