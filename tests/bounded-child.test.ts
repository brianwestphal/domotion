import { expect, it } from "vitest";
import {
  budgetForCpuWork,
  describeChild,
  LOAD_ALLOWANCE,
  MIN_BUDGET_MS,
  runBoundedChild,
  testTimeoutFor,
} from "./bounded-child.js";

it("derives budgets from measured CPU work with a floor for the smallest children", () => {
  expect(budgetForCpuWork(1_300)).toBe(1_300 * LOAD_ALLOWANCE);
  expect(budgetForCpuWork(80)).toBe(MIN_BUDGET_MS);
  // Each sequential child gets its budget plus the SIGKILL grace, then a margin.
  expect(testTimeoutFor(30_000, 50_000)).toBe(30_000 + 5_000 + 50_000 + 5_000 + 5_000);
});

it("returns a completed child's status and output without an error", async () => {
  const result = await runBoundedChild(
    process.execPath,
    ["-e", "process.stdout.write('out');process.stderr.write('err');process.exitCode=3"],
    { budgetMs: MIN_BUDGET_MS },
  );
  expect(result).toMatchObject({ status: 3, signal: null, error: null, stdout: "out", stderr: "err" });
  expect(describeChild(result)).toContain('"status":3');
});

// A hung child is the case the budget exists for: it is stopped and reported
// rather than left running. Its wall time is independent of host load.
it("stops a child that never finishes once its budget elapses", async () => {
  const result = await runBoundedChild(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { budgetMs: 500 });
  expect(result.error).toBe("ETIMEDOUT");
  expect(result.status !== 0 || result.signal !== null).toBe(true);
  expect(result.durationMs).toBeGreaterThanOrEqual(500);
});

// Node emulates SIGTERM on Windows as unconditional termination, so only POSIX
// can show the SIGKILL escalation for a child that ignores SIGTERM.
it.skipIf(process.platform === "win32")(
  "escalates to SIGKILL when a stopped child ignores SIGTERM",
  async () => {
    const result = await runBoundedChild("/bin/sh", ["-c", "trap '' TERM; while :; do sleep 1; done"], {
      budgetMs: 2_000,
    });
    expect(result).toMatchObject({ error: "ETIMEDOUT", signal: "SIGKILL" });
  },
  testTimeoutFor(2_000),
);

it("stops a child whose output exceeds the retained limit", async () => {
  const result = await runBoundedChild(
    process.execPath,
    ["-e", "const b='x'.repeat(1<<20);(function w(){process.stdout.write(b,w)})()"],
    { budgetMs: MIN_BUDGET_MS },
  );
  expect(result.error).toBe("ENOBUFS");
  expect(result.stdout.length).toBeLessThanOrEqual(4 * 1024 * 1024);
});
