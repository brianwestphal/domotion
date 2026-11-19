import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { budgetForCpuWork, describeChild, runBoundedChild, testTimeoutFor } from "./bounded-child.js";

// Proves the E2E setup's screenshot-failure evidence end to end without making
// a real browser fail: the outer test runs this same file in a nested Vitest
// process under the real E2E config, where the inner test launches Chromium
// with a bare `chromium.launch` and then throws the DevTools message by hand.
const SELFTEST = process.env["DOMOTION_E2E_EVIDENCE_SELFTEST"] === "1";
const FILE = "tests/e2e-browser-evidence.e2e.test.ts";
// The nested run (Vitest plus two Chromium launches) used about 1.6 s of CPU
// idle; its wall time scales with host load (docs/tool-child-process-test-bounds.md).
const NESTED_BUDGET_MS = budgetForCpuWork(2_000);
const SIMULATED = "page.screenshot: Protocol error (Page.captureScreenshot): Unable to capture screenshot (simulated)";

// A screenshot in a suite hook fails the suite rather than a test, which the
// setup's file-level afterAll reports.
describe.runIf(SELFTEST)("simulated hook failure", () => {
  beforeAll(() => {
    throw new Error(SIMULATED);
  });
  it("is not reached", () => undefined);
});

describe("E2E screenshot-failure evidence", () => {
  let browser: Browser | undefined;
  afterAll(async () => {
    await browser?.close();
  });

  it.runIf(SELFTEST)("simulated Unable to capture screenshot failure", async () => {
    await browser?.close(); // the retry's attempt replaces the first browser
    // Verbose logging guarantees real browser stderr in the ring for this check.
    browser = await chromium.launch({ headless: true, args: ["--enable-logging=stderr", "--v=1"] });
    const page = await browser.newPage();
    await page.setContent("<p>evidence</p>");
    throw new Error(SIMULATED);
  });

  it.skipIf(SELFTEST)(
    "dumps stamped browser stderr and host samples from a nested E2E run",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "dm-e2e-evidence-e2e-"));
      try {
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("VITEST")));
        const result = await runBoundedChild(
          process.execPath,
          ["node_modules/vitest/vitest.mjs", "run", "--config", "vitest.e2e.config.ts", FILE],
          {
            budgetMs: NESTED_BUDGET_MS,
            env: {
              ...env,
              DOMOTION_E2E_EVIDENCE_SELFTEST: "1",
              DOMOTION_E2E_EVIDENCE_DIR: directory,
              DOMOTION_E2E_HOST_SAMPLES: "1",
              // The outer lane (regular or heavy) names the sample file, so pin
              // the nested run's lane rather than inherit it.
              DOMOTION_E2E_LANE: "all",
            },
          },
        );
        expect(result.error, describeChild(result)).toBeNull();
        const output = `${result.stdout}\n${result.stderr}`;
        // The simulated failure fails the nested run, after the lane's single retry.
        expect(result.status, output).toBe(1);
        expect(output).toContain("[e2e-evidence] Unable to capture screenshot");

        const files = readdirSync(directory);
        const dumps = files.filter((name) => name.startsWith("screenshot-failure-")).sort();
        // The suite hook's failure, then the test's first attempt and its retry.
        expect(dumps, files.join(", ")).toHaveLength(3);
        const hook = dumps.find((name) => name.includes("-simulated-hook-failure-"));
        expect(hook, dumps.join(", ")).toBeDefined();
        expect(readFileSync(join(directory, hook!), "utf8")).toMatch(/^test: .*simulated hook failure$/m);
        dumps.splice(dumps.indexOf(hook!), 1);
        expect(dumps[0]).toMatch(/-simulated-Unable-to-capture-screenshot-failure-a0\.log$/);
        expect(dumps[1]).toMatch(/-a1\.log$/);
        const text = readFileSync(join(directory, dumps[0]!), "utf8");
        expect(text).toMatch(
          /^test: .*E2E screenshot-failure evidence > simulated Unable to capture screenshot failure$/m,
        );
        expect(text).toContain("attempt: 0");
        expect(text).toMatch(/^host: \S+Z load=/m);
        expect(text).toMatch(/^## pid=\d+ exe=\S*(?:chrom|headless_shell)\S* started=\S+ state=live lines=\d+/im);
        const stamped = text.split("\n").filter((line) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z /.test(line));
        expect(stamped.some((line) => line.includes("[evidence] spawned"))).toBe(true);
        // Real Chromium output, not just this module's lifecycle markers.
        expect(stamped.some((line) => !line.includes("[evidence]"))).toBe(true);

        const samples = readFileSync(join(directory, "host-samples-all.log"), "utf8").trim().split("\n");
        // One at start and one at teardown.
        expect(samples.length).toBeGreaterThanOrEqual(2);
        for (const line of samples) expect(line).toMatch(/Z load=[\d.]+,[\d.]+,[\d.]+ cpus=\d+ freeMem=\d+MiB/);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    testTimeoutFor(NESTED_BUDGET_MS),
  );
});
