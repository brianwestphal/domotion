import type { Browser, LaunchOptions } from "@playwright/test";
import { launchChromium } from "../../src/capture/index.js";
import { closeBrowserSafely } from "../../src/test-support/close-browser-safely.js";

export async function withBrowser<T>(run: (browser: Browser) => Promise<T>, options?: LaunchOptions): Promise<T> {
  const browser = await launchChromium(options);
  try {
    return await run(browser);
  } finally {
    await closeBrowserSafely(browser);
  }
}
