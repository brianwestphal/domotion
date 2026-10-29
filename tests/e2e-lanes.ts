export type E2ELane = "all" | "regular" | "heavy";

export const E2E_ALL_FILES = ["src/**/*e2e.test.ts", "tests/**/*e2e.test.ts"] as const;

/**
 * Files whose isolated runtime or Chromium footprint dominated the full lane
 * during the resource-contention audit. Keep this list evidence-based: a file
 * belongs here because it timed out only while competing with the full fork
 * pool, not merely because it has a generous correctness timeout.
 */
export const E2E_HEAVY_FILES = [
  "tests/compressed-run.e2e.test.ts",
  "tests/region-timing.e2e.test.ts",
  "tests/svg-effect-combination-oracle.e2e.test.ts",
] as const;

/**
 * Retry a browser test once, and only for a named hosted-runner transient:
 *
 * - The Page's generic font-family Settings changed between two of its
 *   captures. Hosted macOS runners reset every Chromium's WebPreferences at
 *   once on a host appearance/accessibility event (`OnNativeThemeUpdated` ->
 *   `NotifyPreferencesChanged`), which replaces Playwright's
 *   `Page.setFontFamilies` overlay with Chromium's defaults mid-test (doc 198).
 *   Production deliberately fails closed rather than splice trees from both
 *   sides of that reset, so the error is faithful; the event is one-shot, so a
 *   second attempt captures every tree on one side of it.
 * - DevTools `Page.captureScreenshot` returned "Unable to capture screenshot".
 *   Chromium sends that when the browser-side surface copy comes back empty
 *   (`PageHandler::ScreenshotCaptured`, content/browser/devtools/protocol/
 *   page_handler.cc at 7d859f27), a compositor condition no page content can
 *   cause or prevent.
 *
 * Any other failure, and a second transient-shaped failure, still fails the lane.
 */
export const E2E_HOST_TRANSIENT_RETRY = {
  count: 1,
  condition:
    /different generic-family preference sessions|generic font families changed between capture round|Page\.captureScreenshot\): Unable to capture screenshot/,
} as const;

export const E2E_BASE_EXCLUDES = ["**/node_modules/**", "**/dist/**", "**/tests/output/**"] as const;

export function resolveE2ELane(raw: string | undefined): E2ELane {
  if (raw == null || raw === "") return "all";
  if (raw === "all" || raw === "regular" || raw === "heavy") return raw;
  throw new Error(`DOMOTION_E2E_LANE must be all, regular, or heavy; got ${JSON.stringify(raw)}`);
}

export function e2eLaneConfig(lane: E2ELane): {
  include: string[];
  exclude: string[];
  maxWorkers: number;
} {
  if (lane === "heavy") {
    return {
      include: [...E2E_HEAVY_FILES],
      exclude: [...E2E_BASE_EXCLUDES],
      maxWorkers: 1,
    };
  }
  if (lane === "regular") {
    return {
      include: [...E2E_ALL_FILES],
      exclude: [...E2E_BASE_EXCLUDES, ...E2E_HEAVY_FILES],
      maxWorkers: 2,
    };
  }
  return {
    include: [...E2E_ALL_FILES],
    exclude: [...E2E_BASE_EXCLUDES],
    maxWorkers: 1,
  };
}
