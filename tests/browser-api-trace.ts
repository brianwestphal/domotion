import type { Logger } from "@playwright/test";

/**
 * Records Playwright client API calls (`=> page.evaluate started` /
 * `<= page.evaluate succeeded|failed`) through the public launch `logger`, so a
 * phase that times out can name the browser call still in flight and the
 * source line that issued it, without instrumenting production code.
 */
export interface BrowserApiCall {
  apiName: string;
  /** First non-library stack frame of the caller, e.g. `src/capture/index.ts:2464`. */
  site?: string;
  startedAtMs: number;
  endedAtMs?: number;
  outcome?: "succeeded" | "failed";
}

export interface BrowserApiTrace {
  logger: Logger;
  /** Mark the start of a window; `pending()` and `since()` only report calls after it. */
  mark(): void;
  pending(): Array<BrowserApiCall & { elapsedMs: number }>;
  since(): BrowserApiCall[];
}

const SITE = /(?:\/|\()((?:src|tests)\/[^\s:()]+:\d+)/;

/** Pick the first repository frame that is not this module. */
export function callerSite(stack: string | undefined): string | undefined {
  for (const line of (stack ?? "").split("\n").slice(1)) {
    if (line.includes("browser-api-trace") || line.includes("node_modules")) continue;
    const match = SITE.exec(line);
    if (match != null) return match[1];
  }
  return undefined;
}

export function createBrowserApiTrace(now: () => number = Date.now, limit = 2_000): BrowserApiTrace {
  const calls: BrowserApiCall[] = [];
  let markIndex = 0;
  const started = /^=> (\S+) started$/;
  const ended = /^<= (\S+) (succeeded|failed)$/;
  const logger: Logger = {
    isEnabled: (name) => name === "api",
    log: (name, _severity, message) => {
      if (name !== "api") return;
      const text = String(message);
      const start = started.exec(text);
      if (start != null) {
        // Playwright's own frames exceed V8's default 10-frame limit before the caller's.
        const limitBefore = Error.stackTraceLimit;
        Error.stackTraceLimit = 60;
        const stack = new Error().stack;
        Error.stackTraceLimit = limitBefore;
        const site = callerSite(stack);
        calls.push({ apiName: start[1]!, startedAtMs: now(), ...(site == null ? {} : { site }) });
        if (calls.length > limit) {
          // Drop the oldest completed call; an in-flight one is the evidence.
          const drop = Math.max(
            0,
            calls.findIndex((call) => call.endedAtMs != null),
          );
          calls.splice(drop, 1);
          if (drop < markIndex) markIndex--;
        }
        return;
      }
      const end = ended.exec(text);
      if (end == null) return;
      // Same-name calls can overlap; close the oldest open one (FIFO).
      const open = calls.find((call) => call.apiName === end[1] && call.endedAtMs == null);
      if (open != null) {
        open.endedAtMs = now();
        open.outcome = end[2] as "succeeded" | "failed";
      }
    },
  };
  return {
    logger,
    mark: () => {
      markIndex = calls.length;
    },
    pending: () =>
      calls
        .slice(markIndex)
        .filter((call) => call.endedAtMs == null)
        .map((call) => ({ ...call, elapsedMs: now() - call.startedAtMs })),
    since: () => calls.slice(markIndex).map((call) => ({ ...call })),
  };
}
