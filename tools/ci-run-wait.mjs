const DEFAULT_POLL_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 90 * 60_000;

/**
 * Wait until GitHub reports the whole workflow run completed. `gh run watch`
 * can return as soon as a failing matrix job determines the eventual result,
 * while an `if: always()` aggregate is still queued or publishing artifacts.
 */
export async function waitForRunCompletion(inspect, {
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pollMs = DEFAULT_POLL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  onProgress = () => {},
} = {}) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    try {
      last = await inspect();
      if (last?.status === "completed") return last;
      onProgress(last);
    } catch (error) {
      onProgress({ status: "unknown", error });
    }
    await sleep(pollMs);
  }
  const status = last?.status ?? "unknown";
  throw new Error(`workflow did not complete within ${Math.round(timeoutMs / 60_000)} min (last status: ${status})`);
}
