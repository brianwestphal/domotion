import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCli as parseTruthCollectorCli } from "../tools/animated-image-owner-resource-truth-collector.js";
import { parseArgs as parseCropArgs } from "../tools/crop-regions.js";
import { budgetForCpuWork, describeChild, runBoundedChild, testTimeoutFor } from "./bounded-child.js";

const binary = join(process.cwd(), "node_modules/.bin/tsx");
/** A tsx tool startup measured at most 1.26 s of CPU, idle or loaded. */
const TOOL_BUDGET_MS = budgetForCpuWork(1_300);
function run(command: string, ...argv: string[]) {
  return runBoundedChild(binary, [`tools/${command}`, ...argv], { cwd: process.cwd(), budgetMs: TOOL_BUDGET_MS });
}

describe("migrated A–C commands", () => {
  it("collector validates all required and declared options before launch", () => {
    expect(() => parseTruthCollectorCli(["--unknown"])).toThrow();
    expect(() => parseTruthCollectorCli(["--os"])).toThrow();
    expect(() => parseTruthCollectorCli(["--os", "macOS"])).toThrow(/role/);
  });

  it("crop-regions accepts declared equals-form values", () => {
    expect(parseCropArgs(["--ticket=DM-ABC123", "--output-root=tests/output/region-crops"]).ref).toEqual({
      kind: "slug",
      slug: "DM-ABC123",
    });
  });

  it(
    "broken-image parity rejects a partial matrix at the CLI boundary",
    async () => {
      const child = await run("broken-image-fallback-oracle.ts", "--dpr", "1", "--scheme", "light");
      expect(child.error, describeChild(child)).toBeNull();
      expect(child.status, describeChild(child)).not.toBe(0);
      expect(child.stderr).toContain("--dpr must list exactly 1,2 for the full broken-image parity gate");
    },
    testTimeoutFor(TOOL_BUDGET_MS),
  );

  for (const command of [
    "border-phase-oracle.ts",
    "broken-image-fallback-oracle.ts",
    "browser-harfbuzz-substitution-oracle.ts",
    "cluster-conformance.ts",
    "collapsed-border-fragmentation-oracle.ts",
    "crop-regions.ts",
    "animated-image-frame-selection-audit-cli.ts",
    "animated-image-production-release-gate-cli.ts",
    "assert-linux-system-ui-profile.ts",
    "assert-linux-helper-in-loop.ts",
    "capture-nytimes-snapshot.ts",
    "check-feature-coverage.ts",
  ]) {
    it(
      `${command} rejects unknown options before doing work`,
      async () => {
        const child = await run(command, "--unknown-option");
        expect(child.error, describeChild(child)).toBeNull();
        expect(child.status, describeChild(child)).not.toBe(0);
        expect(child.stderr).toMatch(/unknown|Unknown|invalid/i);
      },
      testTimeoutFor(TOOL_BUDGET_MS),
    );
  }
});
