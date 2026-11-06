import { captureWarningSink } from "../capture/warnings.js";
import type { CaptureWarning } from "../capture/types.js";
import { invokeSynchronousCallback, type SynchronousCallback } from "./text-engine.js";

/**
 * The warning sink of the innermost active `withRenderWarningSink` scope, or
 * null outside every scope. Process-global like the other render scopes, so it
 * is only ever changed by the synchronous scope below.
 */
let activeRenderWarningSink: CaptureWarning[] | null = null;

/**
 * Run one synchronous render with its render warnings appended to `sink`
 * instead of the process-global "last capture" buffer. Without this scope a
 * render's warnings land in whichever capture finished last: rendering an
 * earlier capture's tree after a later capture attributed the earlier tree's
 * degradations to the later capture, and every render grew that unrelated
 * buffer. Scopes nest (the innermost sink wins) and restore the previous sink
 * on return and on throw. The callback must be synchronous — a Promise-like
 * result is rejected, because the sink cannot stay scoped across an `await`.
 */
export function withRenderWarningSink<F extends () => unknown>(
  sink: CaptureWarning[],
  render: SynchronousCallback<F>,
): ReturnType<F> {
  const previous = activeRenderWarningSink;
  activeRenderWarningSink = sink;
  try {
    return invokeSynchronousCallback("withRenderWarningSink", render);
  } finally {
    activeRenderWarningSink = previous;
  }
}

/** Run `render` inside a warning-sink scope when `sink` is given, else as-is. */
export function withOptionalRenderWarningSink<T>(sink: CaptureWarning[] | undefined, render: () => T): T {
  return sink == null ? render() : withRenderWarningSink(sink, render as SynchronousCallback<() => T>);
}

/**
 * Report a render-side degradation: the renderer is about to paint something other than what
 * Chrome painted (a mask dropped, a clip skipped, a gradient approximated, text replaced by a
 * boundary marker).
 *
 * One tag (`[domotion]`) on stderr for a human running the CLI, AND a `CaptureWarning` pushed to
 * the active render's sink (`withRenderWarningSink`, the `warnings` render option) — or, outside
 * any such scope, to the capture warnings global so the CLI and single-capture callers
 * (`getLastCaptureWarnings()`) still see it. Before this each site chose its own prefix and only
 * some warned at all; the silent ones returned null / "" and looked like "nothing to paint".
 *
 * `sink` is for asynchronous render pre-passes (the conic-gradient rasterizer), which run across
 * an `await` and so cannot sit inside a synchronous `withRenderWarningSink` scope: an explicit
 * sink wins over the active scope and the global.
 */
export function renderWarn(feature: string, detail: string, selector = "", sink?: CaptureWarning[]): void {
  console.warn(`[domotion] ${detail}`);
  captureWarningSink(sink ?? activeRenderWarningSink ?? undefined).push({ selector, feature, detail });
}
