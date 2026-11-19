import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { checkActivationCoverage } from "../tools/check-activation-coverage.js";
import { checkNativeScrollbarRelease } from "../tools/check-native-scrollbar-release.js";
import { checkParityRelease } from "../tools/check-parity-release.js";
import { checkSemanticCoverage } from "../tools/check-semantic-coverage.js";
import { budgetForCpuWork, describeChild, runBoundedChild, testTimeoutFor } from "./bounded-child.js";

// The `tsx` CLI run used 0.37-0.41 s of CPU, idle or in a loaded suite, and
// starts two processes (the tsx launcher, then Node with its loader). It once
// took 35.7 s loaded because it checked 894 paths with one awaited `access()`
// after another, each thread-pool round trip waiting about 40 ms to be
// scheduled again; the budget then added 100 ms per path. The inventory now
// checks its paths concurrently and took at most 7 s in loaded suites, so the
// CPU-derived budget applies (docs/tool-child-process-test-bounds.md).
const SEMANTIC_CLI_BUDGET_MS = budgetForCpuWork(400, 2);

describe("migrated check commands", () => {
  it("validates flags before reading reports or ledgers", async () => {
    await expect(checkActivationCoverage(["--json"])).rejects.toThrow();
    await expect(checkActivationCoverage(["--unknown"])).rejects.toThrow();
    await expect(checkNativeScrollbarRelease([])).rejects.toThrow(/reports/);
    await expect(checkNativeScrollbarRelease(["--reports", "missing", "--unknown"])).rejects.toThrow();
    await expect(checkParityRelease(["--evidence"])).rejects.toThrow();
    await expect(checkSemanticCoverage(["--unknown"])).rejects.toThrow();
  });

  it(
    "runs the semantic inventory through the real CLI",
    async () => {
      const result = await runBoundedChild(
        join(process.cwd(), "node_modules/.bin/tsx"),
        ["tools/check-semantic-coverage.ts"],
        { budgetMs: SEMANTIC_CLI_BUDGET_MS, cwd: process.cwd() },
      );
      expect(result.status, describeChild(result)).toBe(0);
      expect(result.stdout).toContain("Semantic coverage inventory is structurally valid");
    },
    testTimeoutFor(SEMANTIC_CLI_BUDGET_MS),
  );

  it("keeps a blocked native release at exit 1 while report-only exits 0", async () => {
    const reports = mkdtempSync(join(tmpdir(), "domotion-scrollbar-cli-"));
    expect(await checkNativeScrollbarRelease(["--reports", reports])).toBe(1);
    expect(await checkNativeScrollbarRelease(["--reports", reports, "--report-only"])).toBe(0);
  });
});
