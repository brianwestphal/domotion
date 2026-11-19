import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { budgetForCpuWork, describeChild, runBoundedChild, testTimeoutFor } from "./bounded-child.js";

/** A tsx tool startup measured at most 1.26 s of CPU, idle or loaded. */
const TOOL_BUDGET_MS = budgetForCpuWork(1_300);
const flagSets = [["--unknown"], ["--json"]];

const commands = [
  "backdrop-source-surface-audit.ts",
  "background-clip-text-oracle.ts",
  "blend-filter-pixel-stage-oracle.ts",
  "animated-projective-frame-oracle.ts",
  "border-phase-ratifier.ts",
  "fragmented-collapsed-table-release-gate.ts",
  "font-palette-ownership-audit.ts",
  "font-palette-paint-gate.ts",
];

describe("migrated paint oracle commands", () => {
  for (const command of commands) {
    it(
      `${command} rejects unknown and missing flags before browser work`,
      async () => {
        for (const args of flagSets) {
          const result = await runBoundedChild(
            join(process.cwd(), "node_modules/.bin/tsx"),
            [`tools/${command}`, ...args],
            { cwd: process.cwd(), budgetMs: TOOL_BUDGET_MS },
          );
          expect(result.error, describeChild(result)).toBeNull();
          expect(result.status, describeChild(result)).toBe(2);
          expect(result.stderr).toMatch(/Unknown option|Option '--json <value>' argument missing/);
        }
      },
      testTimeoutFor(...flagSets.map(() => TOOL_BUDGET_MS)),
    );
  }
});
