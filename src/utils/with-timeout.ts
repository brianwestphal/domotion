/**
 * Settle with `promise`, or with `fallback` once `ms` elapse, whichever comes first. Unlike a bare
 * `Promise.race([p, new Promise((r) => setTimeout(r, ms))])`, the deadline timer is cleared as soon
 * as the race settles, so a fast `promise` does not leave a live timer that holds the Node event
 * loop open (and delays CLI exit) for the rest of `ms`. A rejection of `promise` propagates.
 */
export async function withTimeout<T, F = undefined>(promise: Promise<T>, ms: number, fallback?: F): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<F>((resolve) => {
    timer = setTimeout(() => resolve(fallback as F), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
