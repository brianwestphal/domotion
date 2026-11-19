import { join } from "node:path";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { checkActivationCoverage } from "../tools/check-activation-coverage.js";
import { checkNativeScrollbarRelease } from "../tools/check-native-scrollbar-release.js";
import { checkParityRelease } from "../tools/check-parity-release.js";
import { checkSemanticCoverage } from "../tools/check-semantic-coverage.js";
import { budgetForCpuWork, describeChild, runBoundedChild, testTimeoutFor } from "./bounded-child.js";

/** Repository paths the semantic inventory checks, one awaited `access()` at a time. */
function awaitedPathChecks(): number {
  const inventory = JSON.parse(readFileSync("tools/semantic-coverage.json", "utf8")) as {
    transitions: Partial<Record<string, unknown[]>>[];
  };
  const refKeys = ["upstreamSources", "productionOwners", "oracles", "metamorphicTests", "visualFixtures"];
  return inventory.transitions.reduce(
    (total, row) => total + refKeys.reduce((sum, key) => sum + (row[key]?.length ?? 0), 0),
    1, // the contract path
  );
}

// The `tsx` CLI run used 0.37-0.41 s of CPU, idle or in a loaded suite, and
// starts two processes (the tsx launcher, then Node with its loader). Loaded,
// it still took 35.7 s, because it checks 894 paths with one awaited
// `access()` after another and each thread-pool round trip waited about 40 ms
// to be scheduled again. Each path therefore adds 100 ms to the CPU-derived
// budget (docs/tool-child-process-test-bounds.md).
const PATH_CHECK_ALLOWANCE_MS = 100;
const SEMANTIC_CLI_BUDGET_MS = budgetForCpuWork(400, 2) + awaitedPathChecks() * PATH_CHECK_ALLOWANCE_MS;

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
