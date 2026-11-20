import type { Page } from "@playwright/test";

/**
 * Screenshots for test and oracle harnesses that may run as the first capture
 * of a freshly launched browser.
 *
 * DevTools answers `Page.captureScreenshot` with "Unable to capture screenshot"
 * only when the browser-side surface copy comes back empty
 * (`PageHandler::ScreenshotCaptured`,
 * content/browser/devtools/protocol/page_handler.cc:1831-1835, Chromium
 * 7d859f27). Playwright launches Chromium with
 * `--enable-features=CDPScreenshotNewSurface`, so
 * `RenderWidgetHostImpl::GetSnapshotFromBrowser`
 * (content/browser/renderer_host/render_widget_host_impl.cc:2246-2268) asks the
 * renderer to redraw without waiting for it and issues the copy request
 * straight away. `OnSnapshotFromSurfaceReceived` (same file, 3853-3882) retries
 * an empty copy five times back to back, with no delay. Viz answers a copy
 * request with an empty result at once when the renderer has not yet created
 * its compositor frame sink (`FrameSinkManagerImpl::RequestCopyOfOutput`,
 * components/viz/service/frame_sinks/frame_sink_manager_impl.cc:562-577), and
 * `DelegatedFrameHost::CopyFromCompositingSurfaceInternal`
 * (content/browser/renderer_host/delegated_frame_host.cc:219-223) drops it when
 * the view has no valid local surface id yet. Six immediate copies cannot
 * outlast either state on a slow host.
 *
 * Every hosted-runner occurrence through 2026-11-20 was the first capture of a
 * newly created page, within about two seconds of launch. Two animation frames mean the
 * renderer's compositor has received begin frames through its frame sink and
 * has submitted a frame, so the copy has a surface to read. The wait is bounded
 * in time: a page whose frames never tick still gets its capture, and the
 * outcome is recorded.
 *
 * Only that exact DevTools message is retried, a bounded number of times, each
 * after a fresh frame wait. Each empty copy is reported through `onEmptySurface`
 * (a warning by default), so a recovered failure still leaves evidence in the
 * log. When every attempt is empty the helper throws
 * {@link EmptySurfaceScreenshotError}. Its message keeps the DevTools text, so
 * the E2E host-transient retry and the browser-evidence dump still recognize it,
 * and it adds the per-attempt frame-wait record.
 */

export const EMPTY_SURFACE_SCREENSHOT = /Page\.captureScreenshot\): Unable to capture screenshot/;

export const DEFAULT_SCREENSHOT_ATTEMPTS = 4;
export const DEFAULT_FRAME_TIMEOUT_MS = 5_000;

export interface PresentedFrameWait {
  /** True when two animation frames ran before the deadline. */
  presented: boolean;
  /** Wall-clock time the wait took, in milliseconds. */
  waitMs: number;
}

export interface EmptySurfaceAttempt extends PresentedFrameWait {
  attempt: number;
  error: string;
}

export interface PresentedFrameScreenshotPolicy {
  /** Total capture attempts, including the first. Defaults to 4. */
  attempts?: number;
  /** Upper bound on each two-frame wait. Defaults to 5 s. */
  frameTimeoutMs?: number;
  /** Called for each empty-surface attempt. Defaults to a console warning. */
  onEmptySurface?: (attempt: EmptySurfaceAttempt) => void;
}

export class EmptySurfaceScreenshotError extends Error {
  readonly attempts: readonly EmptySurfaceAttempt[];

  constructor(cause: unknown, attempts: readonly EmptySurfaceAttempt[]) {
    const detail = attempts
      .map((a) => `attempt ${a.attempt}: presented=${a.presented} frameWaitMs=${a.waitMs}`)
      .join("; ");
    super(
      `${errorText(cause)}\n[presented-frame screenshot] every one of ${attempts.length} captures returned an empty surface copy (${detail})`,
      { cause },
    );
    this.name = "EmptySurfaceScreenshotError";
    this.attempts = attempts;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function warnEmptySurface(attempt: EmptySurfaceAttempt): void {
  console.warn(
    `[presented-frame screenshot] empty surface copy on attempt ${attempt.attempt} (presented=${attempt.presented}, frameWaitMs=${attempt.waitMs}): ${attempt.error.split("\n")[0]}`,
  );
}

/** Wait, at most `timeoutMs`, for two animation frames to run in the page. */
export async function waitForPresentedFrame(
  page: Pick<Page, "evaluate">,
  timeoutMs = DEFAULT_FRAME_TIMEOUT_MS,
): Promise<PresentedFrameWait> {
  const started = Date.now();
  const presented = await page.evaluate(
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
  return { presented, waitMs: Date.now() - started };
}

/**
 * `page.screenshot(options)` after the page has presented a frame, retrying
 * only Chromium's empty-surface error. See the module comment for why.
 */
export async function screenshotAfterPresentedFrame(
  page: Pick<Page, "evaluate" | "screenshot">,
  options: Parameters<Page["screenshot"]>[0] = {},
  policy: PresentedFrameScreenshotPolicy = {},
): Promise<Buffer> {
  const attempts = Math.max(1, policy.attempts ?? DEFAULT_SCREENSHOT_ATTEMPTS);
  const onEmptySurface = policy.onEmptySurface ?? warnEmptySurface;
  const empty: EmptySurfaceAttempt[] = [];
  for (let attempt = 1; ; attempt++) {
    const frame = await waitForPresentedFrame(page, policy.frameTimeoutMs);
    try {
      return await page.screenshot(options);
    } catch (error) {
      if (!EMPTY_SURFACE_SCREENSHOT.test(errorText(error))) throw error;
      const record = { attempt, ...frame, error: errorText(error) };
      empty.push(record);
      onEmptySurface(record);
      if (attempt >= attempts) throw new EmptySurfaceScreenshotError(error, empty);
    }
  }
}
