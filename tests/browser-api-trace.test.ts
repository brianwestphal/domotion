import { describe, expect, it } from "vitest";
import { callerSite, createBrowserApiTrace } from "./browser-api-trace.js";

describe("browser API trace", () => {
  it("pairs overlapping same-name calls oldest-first and reports the open one", () => {
    let t = 0;
    const trace = createBrowserApiTrace(() => t);
    const log = (message: string) => trace.logger.log("api", "info", message, [], {});
    log("=> page.evaluate started");
    t = 5;
    log("=> page.evaluate started");
    t = 7;
    log("<= page.evaluate succeeded");
    t = 20;
    expect(trace.pending()).toMatchObject([{ apiName: "page.evaluate", startedAtMs: 5, elapsedMs: 15 }]);
    expect(trace.since()[0]).toMatchObject({ startedAtMs: 0, endedAtMs: 7, outcome: "succeeded" });
  });

  it("windows reports at mark() and records failures", () => {
    let t = 0;
    const trace = createBrowserApiTrace(() => t);
    const log = (message: string) => trace.logger.log("api", "info", message, [], {});
    log("=> browser.newPage started");
    trace.mark();
    t = 3;
    log("=> cdpSession.send started");
    log("<= cdpSession.send failed");
    log("<= browser.newPage succeeded");
    expect(trace.since()).toEqual([{ apiName: "cdpSession.send", startedAtMs: 3, endedAtMs: 3, outcome: "failed" }]);
    expect(trace.pending()).toEqual([]);
  });

  it("ignores other categories and unrelated messages, and bounds its history", () => {
    const trace = createBrowserApiTrace(() => 0, 2);
    expect(trace.logger.isEnabled("api", "info")).toBe(true);
    expect(trace.logger.isEnabled("browser", "info")).toBe(false);
    trace.logger.log("browser", "info", "=> page.goto started", [], {});
    trace.logger.log("api", "info", "waiting for selector", [], {});
    trace.logger.log("api", "info", "<= page.goto succeeded", [], {});
    for (const name of ["a", "b", "c"]) trace.logger.log("api", "info", `=> page.${name} started`, [], {});
    // All open: the oldest goes. Then a completed call is dropped before an open one.
    expect(trace.since().map((call) => call.apiName)).toEqual(["page.b", "page.c"]);
    trace.logger.log("api", "info", "<= page.c succeeded", [], {});
    trace.logger.log("api", "info", "=> page.d started", [], {});
    expect(trace.since().map((call) => call.apiName)).toEqual(["page.b", "page.d"]);
    expect(trace.pending().map((call) => call.apiName)).toEqual(["page.b", "page.d"]);
  });

  it("keeps the mark aligned when trimming calls before it", () => {
    const trace = createBrowserApiTrace(() => 0, 3);
    const log = (message: string) => trace.logger.log("api", "info", message, [], {});
    log("=> page.a started");
    log("<= page.a succeeded");
    log("=> page.b started");
    trace.mark();
    log("=> page.c started");
    log("=> page.d started");
    expect(trace.since().map((call) => call.apiName)).toEqual(["page.c", "page.d"]);
  });

  it("names the first repository frame outside node_modules and this module", () => {
    const stack = [
      "Error",
      "    at log (/work/tests/browser-api-trace.ts:40:20)",
      "    at logApiCall (/work/node_modules/playwright-core/lib/client/channelOwner.js:183:12)",
      "    at captureImageFontHinting (/work/src/capture/image-font-hinting.ts:45:19)",
      "    at /work/tests/image-svg-vdmx-hinting-linux.e2e.test.ts:80:11",
    ].join("\n");
    expect(callerSite(stack)).toBe("src/capture/image-font-hinting.ts:45");
    expect(callerSite("Error\n    at native")).toBeUndefined();
    expect(callerSite(undefined)).toBeUndefined();
  });
});
