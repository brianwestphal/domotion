import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  coverageCommandExitStatus,
  normalizeCoverageExitStatus,
} from "../tools/coverage-exit-status.mjs";
import {
  missingBrowserClientSources,
  requiredBrowserClientSources,
} from "../tools/browser-coverage-client-sources.mjs";
import { startBrowserCoverage, writeBrowserCoverage } from "../src/test-support/browser-coverage.js";

const originalBrowserCoverageDirectory = process.env.DOMOTION_BROWSER_COVERAGE_DIR;

afterEach(() => {
  if (originalBrowserCoverageDirectory == null) delete process.env.DOMOTION_BROWSER_COVERAGE_DIR;
  else process.env.DOMOTION_BROWSER_COVERAGE_DIR = originalBrowserCoverageDirectory;
});

describe("merged coverage exit propagation", () => {
  it("passes only when every required suite and c8 pass", () => {
    expect(coverageCommandExitStatus([0, 0, 0, 0], 0)).toBe(0);
  });

  it.each([
    [[1, 0, 0], 0],
    [[0, 2, 0], 0],
    [[0, 0, null], 0],
  ] as const)("fails when any constituent suite fails (%j)", (suiteStatuses, reportStatus) => {
    expect(coverageCommandExitStatus([...suiteStatuses], reportStatus)).toBe(1);
  });

  it("preserves a nonzero c8 report status when the suites passed", () => {
    expect(coverageCommandExitStatus([0, 0], 3)).toBe(3);
  });

  it("maps a signal or spawn failure without an exit status to 1", () => {
    expect(normalizeCoverageExitStatus(null)).toBe(1);
    expect(normalizeCoverageExitStatus(undefined)).toBe(1);
  });
});

describe("browser client coverage requirements", () => {
  const root = "/repo";

  it("requires the review, scrubber, and studio entry points", () => {
    expect(requiredBrowserClientSources(root)).toEqual([
      "/repo/src/review/client.tsx",
      "/repo/src/scrubber/client.tsx",
      "/repo/src/studio/client.tsx",
    ]);
  });

  it("reports every client entry point absent from the converted browser map", () => {
    expect(missingBrowserClientSources([
      "/repo/src/review/client.tsx",
      "/repo/src/studio/client.tsx",
    ], root)).toEqual(["/repo/src/scrubber/client.tsx"]);
  });

  it("passes when all three browser client entry points are present", () => {
    const required = requiredBrowserClientSources(root);
    expect(missingBrowserClientSources(required, root)).toEqual([]);
  });
});

describe("browser coverage collection", () => {
  it("is inert outside the merged coverage workflow", async () => {
    delete process.env.DOMOTION_BROWSER_COVERAGE_DIR;
    const startJSCoverage = vi.fn();
    const page = { coverage: { startJSCoverage } };

    await expect(startBrowserCoverage(page as never)).resolves.toBe(false);
    expect(startJSCoverage).not.toHaveBeenCalled();
  });

  it("records only generated browser client scripts for conversion", async () => {
    const directory = mkdtempSync(join(tmpdir(), "domotion-browser-coverage-"));
    process.env.DOMOTION_BROWSER_COVERAGE_DIR = directory;
    const startJSCoverage = vi.fn();
    const stopJSCoverage = vi.fn().mockResolvedValue([
      { url: "http://127.0.0.1:3000/client.js", source: "review", functions: [] },
      { url: "http://127.0.0.1:3000/vendor.js", source: "vendor", functions: [] },
      { url: "http://127.0.0.1:3000/client.js?v=1", source: "studio", functions: [] },
    ]);
    const page = { coverage: { startJSCoverage, stopJSCoverage } };

    try {
      await expect(startBrowserCoverage(page as never)).resolves.toBe(true);
      expect(startJSCoverage).toHaveBeenCalledWith({
        resetOnNavigation: false,
        reportAnonymousScripts: true,
      });
      await writeBrowserCoverage(page as never, "test-client", true);
      const [output] = readdirSync(directory);
      const entries = JSON.parse(readFileSync(join(directory, output), "utf8")) as Array<{ url: string }>;
      expect(entries.map((entry) => entry.url)).toEqual([
        "http://127.0.0.1:3000/client.js",
        "http://127.0.0.1:3000/client.js?v=1",
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
