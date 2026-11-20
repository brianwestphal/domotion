import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { budgetForCpuWork, describeChild, runBoundedChild, testTimeoutFor } from "./bounded-child.js";
import { CHILD_EVIDENCE_FLAG } from "./e2e-child-evidence.js";

// End-to-end check of child-process screenshot evidence: the E2E setup opts
// this worker's Node children in through NODE_OPTIONS, and a child that
// launches Chromium through Playwright and reports "Unable to capture
// screenshot" writes the stamped browser stderr when it exits.
const CHILD = "tests/fixtures/e2e-child-evidence/child.mjs";
// One Chromium launch plus tsx's loader start; wall time scales with host load.
const CHILD_BUDGET_MS = budgetForCpuWork(1_500);

async function runChild(mode: "fail" | "pass", directory: string) {
  const result = await runBoundedChild(process.execPath, [CHILD], {
    budgetMs: CHILD_BUDGET_MS,
    env: { ...process.env, CHILD_MODE: mode, DOMOTION_E2E_EVIDENCE_DIR: directory },
  });
  expect(result.error, describeChild(result)).toBeNull();
  return result;
}

describe("E2E child-process screenshot-failure evidence", () => {
  it("is configured for this worker's children", () => {
    expect(process.env[CHILD_EVIDENCE_FLAG]).toBe("1");
    expect(process.env["NODE_OPTIONS"]).toContain("e2e-child-evidence-preload.mjs");
  });

  it(
    "writes stamped Chromium stderr when a child reports the failure",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "dm-e2e-child-evidence-"));
      try {
        const result = await runChild("fail", directory);
        const output = `${result.stdout}\n${result.stderr}`;
        expect(result.status, output).toBe(1);
        expect(output).toMatch(/\[e2e-evidence\] child pid \d+: Unable to capture screenshot/);
        const dumps = readdirSync(directory).filter((name) => name.startsWith("screenshot-failure-"));
        expect(dumps, readdirSync(directory).join(", ")).toHaveLength(1);
        const text = readFileSync(join(directory, dumps[0]!), "utf8");
        expect(text).toMatch(/^test: child: .*child\.mjs$/m);
        expect(text).toMatch(/^## pid=\d+ exe=\S*(?:chrom|headless_shell)\S* started=\S+ exited=\S+ code=/im);
        const stamped = text.split("\n").filter((line) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z /.test(line));
        expect(stamped.some((line) => line.includes("[evidence] spawned"))).toBe(true);
        // Real Chromium output, not only this module's lifecycle markers.
        expect(stamped.some((line) => !line.includes("[evidence]"))).toBe(true);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    testTimeoutFor(CHILD_BUDGET_MS),
  );

  it(
    "writes nothing for a child that does not report it",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "dm-e2e-child-evidence-"));
      try {
        const result = await runChild("pass", directory);
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect(result.stderr).not.toContain("[e2e-evidence]");
        expect(readdirSync(directory)).toEqual([]);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    testTimeoutFor(CHILD_BUDGET_MS),
  );
});
