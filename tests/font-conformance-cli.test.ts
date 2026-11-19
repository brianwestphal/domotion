import { describe, expect, it } from "vitest";
import {
  budgetForCpuWork,
  describeChild,
  runBoundedChild,
  testTimeoutFor,
  type BoundedChildResult,
} from "./bounded-child.js";

// A `node --import tsx` start of the oracle that rejects its arguments used
// 0.65-0.67 s of CPU idle and up to 1.0 s inside a loaded suite, where its wall
// time reached 17.8 s (docs/tool-child-process-test-bounds.md).
const PREFLIGHT_BUDGET_MS = budgetForCpuWork(1_000);

async function run(args: string[]): Promise<BoundedChildResult> {
  const result = await runBoundedChild(process.execPath, ["--import", "tsx", "tools/font-conformance.ts", ...args], {
    budgetMs: PREFLIGHT_BUDGET_MS,
    cwd: process.cwd(),
  });
  expect(result.error, describeChild(result)).toBeNull();
  return result;
}

describe("font-conformance CLI preflight", () => {
  it(
    "rejects an out-of-range shard with usage status before launching Chromium",
    async () => {
      const result = await run(["--shard", "0/8"]);
      expect(result.status, describeChild(result)).toBe(2);
      expect(result.stderr).toContain("out of range");
      expect(result.stdout).not.toContain("codepoints ×");
    },
    testTimeoutFor(PREFLIGHT_BUDGET_MS),
  );

  it(
    "rejects zero selected codepoints and stacks instead of reporting agreement",
    async () => {
      const noCodepoints = await run(["--range", "0041", "--shard", "2/2"]);
      expect(noCodepoints.status, describeChild(noCodepoints)).toBe(2);
      expect(noCodepoints.stderr).toContain("refusing an empty sweep");

      const noStacks = await run(["--max-stacks", "1", "--stack-shard", "2/2"]);
      expect(noStacks.status, describeChild(noStacks)).toBe(2);
      expect(noStacks.stderr).toContain("refusing an empty sweep");
    },
    testTimeoutFor(PREFLIGHT_BUDGET_MS, PREFLIGHT_BUDGET_MS),
  );

  it(
    "rejects malformed batch size without entering the sweep loop",
    async () => {
      const result = await run(["--batch", "abc"]);
      expect(result.status, describeChild(result)).toBe(2);
      expect(result.stderr).toContain("--batch needs an integer");
    },
    testTimeoutFor(PREFLIGHT_BUDGET_MS),
  );
});
