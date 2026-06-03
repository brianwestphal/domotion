import type { Browser } from "@playwright/test";

/**
 * DM-1074: Playwright's `browser.close()` occasionally HANGS — Chromium doesn't
 * exit cleanly (reproducible even on a bare `chromium.launch()` under load, with
 * no leaked processes). In test teardown that hang blows the hook/test timeout
 * and reds the WHOLE file even though every assertion passed.
 *
 * These helpers race the close against a deadline and, if it doesn't resolve in
 * time, **abandon** it so teardown completes and the suite stays green. A
 * `chromium.launch()` `Browser` exposes no public process handle (only
 * `launchServer()`'s `BrowserServer` has `.process()`), so we can't SIGKILL it
 * directly — but an abandoned-close Chromium is a child of the vitest worker and
 * is reaped when that worker exits, so it doesn't leak past the run.
 *
 * Lives under `src/test-support/` (excluded from the shipped `dist/` via tsconfig.build).
 */

const ABANDON_MS = 6_000;

/** Close a browser, abandoning the close if it doesn't resolve within `timeoutMs`. */
export async function closeBrowserSafely(browser: Browser | null | undefined, timeoutMs = ABANDON_MS): Promise<void> {
  if (browser == null) return;
  await raceWithDeadline(() => browser.close(), timeoutMs);
}

/**
 * Race an arbitrary async close (e.g. a server handle's `close()` that itself
 * calls `browser.close()`) against the same deadline, so a hung Chromium-close
 * inside it can't stall teardown. `browser` is accepted for call-site symmetry.
 */
export async function closeSafely(closeFn: () => Promise<void>, _browser?: Browser | null, timeoutMs = ABANDON_MS): Promise<void> {
  await raceWithDeadline(closeFn, timeoutMs);
}

async function raceWithDeadline(fn: () => Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); });
  try {
    await Promise.race([Promise.resolve().then(fn).catch(() => {}), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
