import type { Page } from "@playwright/test";

/**
 * A bounded wait for the page to present a frame before a capture that may be
 * the first one on a freshly launched browser.
 *
 * Playwright launches Chromium with `--enable-features=CDPScreenshotNewSurface`,
 * so `RenderWidgetHostImpl::GetSnapshotFromBrowser`
 * (content/browser/renderer_host/render_widget_host_impl.cc:2246-2268, Chromium
 * 7d859f27) asks the renderer to redraw without waiting and copies the surface
 * at once, retrying an empty copy five times back to back
 * (`OnSnapshotFromSurfaceReceived`, same file, 3853-3882). Viz answers empty
 * while the renderer has no compositor frame sink yet
 * (`FrameSinkManagerImpl::RequestCopyOfOutput`,
 * components/viz/service/frame_sinks/frame_sink_manager_impl.cc:562-577), and
 * DevTools then reports "Unable to capture screenshot"
 * (content/browser/devtools/protocol/page_handler.cc:1831-1835).
 *
 * Measured on hosted macOS runners (six browsers at once on three vCPUs): the
 * first capture of a fresh browser's first page failed 55 of 1,800 times, and
 * 24 of 1,800 after the GPU feature-info barrier `launchChromium` applies. A new
 * page in an already-running browser failed 0 of 1,800 times. A capture after
 * two animation frames failed 0 of 1,200 times. `svg-to-image` failed 0 of 900
 * times because its seek already waits two frames
 * (`seekAnimationsToFrame`).
 *
 * Two animation frames mean the renderer's compositor has received begin
 * frames through its frame sink and submitted a frame. The deadline is
 * enforced from Node as well as in the page, so a page whose timers or
 * animation frames are frozen cannot hold the wait open.
 */

export const DEFAULT_FRAME_TIMEOUT_MS = 5_000;

export interface PresentedFrameWait {
  /** True when two animation frames ran before the deadline. */
  presented: boolean;
  /** Wall-clock time the wait took, in milliseconds. */
  waitMs: number;
}

/**
 * Wait, at most `timeoutMs`, for two animation frames to run in the page.
 *
 * The deadline is enforced from Node as well as in the page: a page whose
 * timers have been replaced (the real-world DOM freeze does this) or whose
 * `requestAnimationFrame` never calls back would otherwise hold the evaluation
 * open forever. An in-flight evaluation that loses the race is left to settle
 * on its own; its result is ignored.
 */
export async function waitForPresentedFrame(
  page: Pick<Page, "evaluate">,
  timeoutMs = DEFAULT_FRAME_TIMEOUT_MS,
): Promise<PresentedFrameWait> {
  const started = Date.now();
  const inPage = page.evaluate(
    (deadline) =>
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), deadline);
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            clearTimeout(timer);
            resolve(true);
          }),
        );
      }),
    timeoutMs,
  );
  let nodeTimer: ReturnType<typeof setTimeout> | undefined;
  const nodeDeadline = new Promise<boolean>((resolve) => {
    nodeTimer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    const presented = await Promise.race([inPage, nodeDeadline]);
    return { presented, waitMs: Date.now() - started };
  } finally {
    clearTimeout(nodeTimer);
    // A losing evaluation may still reject later (for example when the page
    // closes); it no longer has an observer.
    inPage.catch(() => {});
  }
}
