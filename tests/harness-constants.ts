import type { Page } from "@playwright/test";

/** The visual harness allows slower local font discovery and image loads. */
export const HARNESS_PAGE_TIMEOUT_MS = 90_000;

/** Unhinted paths still carry a platform raster floor against Chromium. */
export const HINTING_FLOOR_PCT: Readonly<Record<string, number>> = { win32: 4.0, linux: 1.0 };

export function newHarnessPage<T extends Pick<Page, "setDefaultTimeout" | "setDefaultNavigationTimeout">>(page: T): T {
  page.setDefaultTimeout(HARNESS_PAGE_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(HARNESS_PAGE_TIMEOUT_MS);
  return page;
}
