import type { Browser, LaunchOptions } from "@playwright/test";
import { launchChromium } from "../../src/capture/index.js";
import { closeBrowserSafely } from "../../src/test-support/close-browser-safely.js";

export interface BrowserOwnership {
  launch?: (options?: LaunchOptions) => Promise<Browser>;
  closeTimeoutMs?: number;
}

/** For harnesses that must return a browser to their caller. Closing is safe and idempotent. */
export async function openOwnedBrowser(options?: LaunchOptions, ownership: BrowserOwnership = {}) {
  const browser = await (ownership.launch ?? launchChromium)(options);
  let closed = false;
  return {
    browser,
    close: async (): Promise<void> => {
      if (closed) return;
      closed = true;
      if (ownership.closeTimeoutMs == null) await closeBrowserSafely(browser);
      else await closeBrowserSafely(browser, ownership.closeTimeoutMs);
    },
  };
}

export async function withBrowser<T>(
  run: (browser: Browser) => Promise<T>,
  options?: LaunchOptions,
  ownership: BrowserOwnership = {},
): Promise<T> {
  const owner = await openOwnedBrowser(options, ownership);
  try {
    return await run(owner.browser);
  } finally {
    await owner.close();
  }
}
