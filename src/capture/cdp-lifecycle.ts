/**
 * Cleanup helpers for the capture pipeline's per-page prepasses and CDP sessions.
 *
 * Cleanup runs in `finally` blocks, where two mistakes are easy: a cleanup step
 * that throws REPLACES the error that got us there, and a sequence of cleanup
 * steps aborts at the first throw, leaving private keys and `globalThis` stashes
 * on a page the caller reuses. These helpers make both impossible.
 */

import type { CDPSession, Frame, Page } from "@playwright/test";

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

/** Prepare independent capture resources together, disposing successful ones if any fail. */
export async function runPrepasses<const T extends readonly { prepare(): Promise<AsyncDisposable> }[]>(
  entries: T,
): Promise<{ [K in keyof T]: Awaited<ReturnType<T[K]["prepare"]>> }> {
  const results = await Promise.allSettled(entries.map((entry) => entry.prepare()));
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") {
    const prepared = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
    try {
      await disposeAll(...prepared);
    } catch (cleanupError) {
      throw new AggregateError([failure.reason, cleanupError], "capture prepass preparation and cleanup failed");
    }
    throw failure.reason;
  }
  return results.map((result) => (result as PromiseFulfilledResult<AsyncDisposable>).value) as {
    [K in keyof T]: Awaited<ReturnType<T[K]["prepare"]>>;
  };
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
  return /part of the parent frame's session|does not have a separate CDP session/i.test(String(error));
}

/** Own one CDP session for the duration of an operation. */
export async function withCdpSession<Result>(
  target: Page | Frame,
  work: (session: CDPSession) => Promise<Result>,
  options: { sameProcessFrame?: () => Promise<Result> | Result } = {},
): Promise<Result> {
  const page = "page" in target ? target.page() : target;
  let session: CDPSession;
  try {
    session = await page.context().newCDPSession(target);
  } catch (error) {
    if (target !== page && isSameProcessFrameError(error) && options.sameProcessFrame != null) {
      return await options.sameProcessFrame();
    }
    throw error;
  }
  try {
    return await work(session);
  } finally {
    await detachQuietly(session);
  }
}
