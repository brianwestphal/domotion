import type { Page } from "@playwright/test";
import { captureElementTreeWithDebug, type CaptureElementTreeOptions } from "../src/capture/index.js";
import { evaluateInFrame } from "../src/capture/evaluate-in-frame.js";
import { withTimeout } from "../src/utils/with-timeout.js";

/** Keep anchor source pixels with the tree, without advancing finite animations. */
export async function captureRealWorldScrollReference(
  page: Page,
  selector: string = "body",
  viewport: { x: number; y: number; width: number; height: number },
  options?: CaptureElementTreeOptions,
) {
  const pause = Promise.all(
    page.frames().map((frame) =>
      evaluateInFrame(frame, async () => {
        const pending: Promise<Animation>[] = [];
        for (const animation of document.getAnimations()) {
          const time = animation.currentTime;
          // An inactive progress timeline has no resolved effect to freeze. Its
          // ready promise may stay pending until the timeline becomes active.
          if (
            time == null &&
            animation.timeline?.currentTime == null &&
            animation.effect?.getComputedTiming().progress == null
          )
            continue;
          animation.pause();
          // Web Animations' current-time setter completes a pending pause
          // synchronously. Assign the sampled value, never the effect's end.
          if (time != null) animation.currentTime = time;
          if (animation.pending) pending.push(animation.ready);
          else if (animation.playState !== "paused") throw new Error("Scroll reference animation did not pause");
        }
        for (const animation of await Promise.all(pending)) {
          if (animation.pending || animation.playState !== "paused")
            throw new Error("Scroll reference animation did not settle paused");
        }
      }),
    ),
  );
  const expired = Symbol("scroll-reference-pause-deadline");
  // The page may freeze/override timers. Unsettled active paint must fail the
  // reference operation, never silently proceed after its Node-owned bound.
  if ((await withTimeout(pause, 2000, expired)) === expired)
    throw new Error("Scroll reference animation pause exceeded 2000ms");
  return captureElementTreeWithDebug(page, selector, viewport, options);
}
