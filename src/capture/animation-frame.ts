import type { Frame, Page } from "@playwright/test";

export interface StableAnimationDocumentState {
  url: string;
  animationCount: number;
  smilTimelineCount: number;
  failures: string[];
}

/**
 * Exact document-timeline state installed before a frame-scoped capture.
 *
 * `requestedTimeMs` is intentionally the caller's finite number rather than a
 * sampled wall-clock value. Chromium owns interpolation and composition; this
 * record only proves that every participating document was paused at that
 * caller-owned time before geometry/paint prepasses began.
 */
export interface StableAnimationFrameState {
  source: "chromium-paused-document-timeline-v1";
  requestedTimeMs: number;
  animationCount: number;
  smilTimelineCount: number;
  documents: StableAnimationDocumentState[];
}

export interface SeekAnimationsToFrameOptions {
  /** Fail rather than silently sampling a timeline that refused the seek. */
  strict?: boolean;
  /** Seek same- and cross-origin child frames as well as the top document. */
  includeChildFrames?: boolean;
}

const CURRENT_TIME_EPSILON_MS = 0.02;

async function seekDocumentFrame(frame: Frame, timeMs: number): Promise<StableAnimationDocumentState> {
  return frame.evaluate(async ({ requestedTimeMs, epsilonMs }) => {
    const failures: string[] = [];
    const root = document.documentElement as unknown as { __domotionSeekSettled?: boolean } | null;

    // A CSS animation joins the document timeline only after the first style
    // recalc. Settle once per Document before enumeration (DM-1781), then
    // settle again after the seek so every later CDP/layout read observes the
    // same committed compositor frame.
    if (root != null && root.__domotionSeekSettled !== true) {
      root.__domotionSeekSettled = true;
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
    }

    const before = typeof document.getAnimations === "function" ? document.getAnimations() : [];
    for (let index = 0; index < before.length; index++) {
      const animation = before[index];
      try {
        animation.pause();
        animation.currentTime = requestedTimeMs;
      } catch (error) {
        failures.push(`animation[${index}] refused document-time seek: ${String(error)}`);
      }
    }

    let smilTimelineCount = 0;
    const smilRoots: SVGSVGElement[] = [];
    for (const svg of document.querySelectorAll("svg")) {
      if (typeof svg.pauseAnimations !== "function") continue;
      smilTimelineCount++;
      smilRoots.push(svg);
      try {
        svg.pauseAnimations();
        svg.setCurrentTime(requestedTimeMs / 1000);
      } catch (error) {
        failures.push(`smil[${smilTimelineCount - 1}] refused document-time seek: ${String(error)}`);
      }
    }

    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });

    const after = typeof document.getAnimations === "function" ? document.getAnimations() : [];
    if (after.length !== before.length) {
      failures.push(`animation enumeration changed during settle: ${before.length} -> ${after.length}`);
    }
    for (let index = 0; index < after.length; index++) {
      const animation = after[index];
      const currentTime = animation.currentTime;
      if (typeof currentTime !== "number") {
        failures.push(`animation[${index}] has a non-document timeline currentTime`);
        continue;
      }
      if (Math.abs(currentTime - requestedTimeMs) > epsilonMs) {
        failures.push(`animation[${index}] drifted to ${currentTime}ms`);
      }
      if (animation.playState !== "paused" && animation.playState !== "finished") {
        failures.push(`animation[${index}] remained ${animation.playState}`);
      }
    }
    for (let index = 0; index < smilRoots.length; index++) {
      const currentTimeSeconds = smilRoots[index].getCurrentTime();
      if (!Number.isFinite(currentTimeSeconds)
        || Math.abs(currentTimeSeconds * 1000 - requestedTimeMs) > epsilonMs) {
        failures.push(`smil[${index}] drifted to ${currentTimeSeconds}s`);
      }
    }

    return {
      url: location.href,
      animationCount: after.length,
      smilTimelineCount,
      failures,
    };
  }, { requestedTimeMs: timeMs, epsilonMs: CURRENT_TIME_EPSILON_MS });
}

/**
 * Pause CSS/WAAPI and SMIL animation timelines at one exact time and wait for
 * Chromium to commit that state to paint. Geometry capture must call this
 * before *any* prepass; otherwise independently scheduled CDP/layout reads can
 * straddle two compositor frames.
 */
export async function seekAnimationsToFrame(
  page: Page,
  timeMs: number,
  options: SeekAnimationsToFrameOptions = {},
): Promise<StableAnimationFrameState> {
  if (!Number.isFinite(timeMs) || timeMs < 0) {
    throw new Error(`animationTimeMs must be a finite non-negative number (got ${String(timeMs)})`);
  }

  const frames = options.includeChildFrames === false ? [page.mainFrame()] : page.frames();
  const documents = await Promise.all(frames.map(async (frame) => {
    try {
      return await seekDocumentFrame(frame, timeMs);
    } catch (error) {
      return {
        url: frame.url(),
        animationCount: 0,
        smilTimelineCount: 0,
        failures: [`document frame could not be seeked: ${String(error)}`],
      };
    }
  }));
  const failures = documents.flatMap((documentState) =>
    documentState.failures.map((failure) => `${documentState.url || "about:blank"}: ${failure}`));
  if (options.strict === true && failures.length > 0) {
    throw new Error(`Stable animation frame unavailable at ${timeMs}ms:\n${failures.join("\n")}`);
  }
  return {
    source: "chromium-paused-document-timeline-v1",
    requestedTimeMs: timeMs,
    animationCount: documents.reduce((sum, state) => sum + state.animationCount, 0),
    smilTimelineCount: documents.reduce((sum, state) => sum + state.smilTimelineCount, 0),
    documents,
  };
}
