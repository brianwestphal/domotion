import type { Browser, LaunchOptions } from "@playwright/test";

export interface BrowserOwnership {
  launch?: (options?: LaunchOptions) => Promise<Browser>;
  closeTimeoutMs?: number;
}

export function openOwnedBrowser(
  options?: LaunchOptions,
  ownership?: BrowserOwnership,
): Promise<{ browser: Browser; close(): Promise<void> }>;
export function withBrowser<T>(
  run: (browser: Browser) => Promise<T>,
  options?: LaunchOptions,
  ownership?: BrowserOwnership,
): Promise<T>;
