/**
 * Cleanup helpers for the capture pipeline's per-page prepasses and CDP sessions.
 *
 * Cleanup runs in `finally` blocks, where two mistakes are easy: a cleanup step
 * that throws REPLACES the error that got us there, and a sequence of cleanup
 * steps aborts at the first throw, leaving private keys and `globalThis` stashes
 * on a page the caller reuses. These helpers make both impossible.
 */

/** Anything with an async teardown (a prepass, a probe, a frame transaction). */
export interface AsyncDisposable {
  dispose(): Promise<void>;
}

/**
 * Run every disposer, whether or not an earlier one fails, then rethrow the FIRST
 * failure (later ones are attached as `cause` on an `AggregateError` when there
 * are several). `undefined` entries are skipped so optional prepasses can be
 * passed directly.
 */
export async function disposeAll(...disposables: ReadonlyArray<AsyncDisposable | undefined | null>): Promise<void> {
  const results = await Promise.allSettled(disposables.map((d) => d?.dispose()));
  const failures = results.flatMap((r) => (r.status === "rejected" ? [r.reason as unknown] : []));
  if (failures.length === 0) return;
  if (failures.length === 1) throw failures[0];
  throw new AggregateError(failures, `${failures.length} capture disposers failed`);
}

/** Minimal shape of a Playwright `CDPSession` this module needs. */
export interface DetachableSession {
  detach(): Promise<void>;
}

/**
 * Detach a CDP session without ever throwing. A `detach()` rejection (the target
 * already closed, the session already detached) is expected during teardown and
 * must not mask the error that ended the work.
 */
export async function detachQuietly(session: DetachableSession | null | undefined): Promise<void> {
  await session?.detach().catch(() => undefined);
}

/**
 * True when Playwright refused a per-frame CDP session because the frame is a
 * same-process child of its parent: such a frame has no session of its own and is
 * served by the parent's, so callers fall back to the page session (or skip).
 */
export function isSameProcessFrameError(error: unknown): boolean {
  return /part of the parent frame's session/i.test(String(error));
}
