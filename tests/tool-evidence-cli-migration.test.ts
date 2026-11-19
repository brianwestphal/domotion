import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkBackgroundClipTextNative } from "../tools/background-clip-text-native-gate.js";
import { budgetForCpuWork, describeChild, runBoundedChild, testTimeoutFor } from "./bounded-child.js";

// `tsx` starts of these tools that reject their arguments used 0.20-1.00 s of
// CPU, idle and loaded (docs/tool-child-process-test-bounds.md).
const TOOL_BUDGET_MS = budgetForCpuWork(1_100);
const runTool = (args: string[]) =>
  runBoundedChild(join(process.cwd(), "node_modules/.bin/tsx"), args, {
    budgetMs: TOOL_BUDGET_MS,
    cwd: process.cwd(),
  });

describe("migrated evidence commands", () => {
  it("rejects unknown native-gate options before reading reports", () => {
    expect(() => checkBackgroundClipTextNative(["--unknown"])).toThrow();
  });

  const argvs = [["--json"], ["--unknown"]];
  for (const command of ["animated-culling-geometry-oracle.ts", "build-stage-evidence.ts"]) {
    it(
      `${command} rejects missing and unknown options`,
      async () => {
        for (const argv of argvs) {
          const child = await runTool([`tools/${command}`, ...argv]);
          expect(child.status, describeChild(child)).toBe(2);
        }
      },
      testTimeoutFor(...argvs.map(() => TOOL_BUDGET_MS)),
    );
  }

  it(
    "keeps adjudicator parse failures redacted",
    async () => {
      const child = await runTool(["tools/animated-image-owner-resource-truth-adjudicator.ts", "--secret"]);
      expect(child.status, describeChild(child)).toBe(1);
      expect(child.stderr).toContain("failed closed before verdict");
      expect(child.stderr).not.toContain("--secret");
    },
    testTimeoutFor(TOOL_BUDGET_MS),
  );
});
