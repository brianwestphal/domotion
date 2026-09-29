/**
 * Bounded synchronous retry with exponential backoff, for the resource-pressure
 * failures (EMFILE / spawn failure / helper transport) that must not become a
 * permanent "unopenable" or "no such family" answer.
 *
 * The render pipeline is synchronous end to end, so the wait blocks the thread
 * with `Atomics.wait` on a private buffer instead of spinning.
 */

/** Default attempt budget; the backoff is `baseMs * 2 ** attempt` between attempts. */
export const RETRY_ATTEMPTS = 6;
const RETRY_BASE_MS = 25;

/** Synchronously sleep without burning a core. Silently returns at once when
 *  `SharedArrayBuffer` is unavailable (a locked-down embedder): the retry
 *  still happens, only its backoff is lost. */
export function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* no SharedArrayBuffer */
  }
}

export interface RetrySyncOptions {
  /** Total tries including the first. Default {@link RETRY_ATTEMPTS}. */
  attempts?: number;
  /** First backoff; doubles each attempt. Default 25 ms. */
  baseMs?: number;
  /** Return false to stop retrying and rethrow at once. Default: retry everything. */
  shouldRetry?: (error: unknown) => boolean;
}

/** Run `fn`, retrying on a thrown error until the budget is spent; the last
 *  error is rethrown. No wait follows the final attempt. */
export function retrySync<T>(fn: () => T, options: RetrySyncOptions = {}): T {
  const attempts = options.attempts ?? RETRY_ATTEMPTS;
  const baseMs = options.baseMs ?? RETRY_BASE_MS;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return fn();
    } catch (error) {
      lastError = error;
      if (options.shouldRetry?.(error) === false || attempt + 1 >= attempts) throw error;
      sleepSync(baseMs * 2 ** attempt);
    }
  }
  throw lastError;
}

/** True for the file-descriptor / resource-pressure codes worth retrying. */
export function isTransientFsError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "EMFILE" || code === "ENFILE" || code === "EAGAIN";
}
