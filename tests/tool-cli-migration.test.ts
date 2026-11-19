import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectStageEvidence } from "../tools/collect-stage-evidence.js";
import { compareRollEvidence } from "../tools/compare-roll-evidence.js";
import { produceProjectiveOwnerRelease } from "../tools/projective-owner-release-producer.js";
import { runHelperAvailabilityContract } from "../tools/helper-availability-contract.js";
import { parseCli as parseAnimatedFixtureCli } from "../tools/animated-image-owner-resource-truth-fixtures.js";
import { budgetForCpuWork, describeChild, runBoundedChild, testTimeoutFor } from "./bounded-child.js";

// Each `tsx` CLI run used 0.32-0.36 s of CPU, idle or in a loaded suite, and
// starts two processes (the tsx launcher, then Node with its loader). Loaded,
// a run took up to 14 s (docs/tool-child-process-test-bounds.md).
const ROLL_CLI_BUDGET_MS = budgetForCpuWork(360, 2);
const runRollCli = (args: string[]) =>
  runBoundedChild(join(process.cwd(), "node_modules/.bin/tsx"), ["tools/compare-roll-evidence.ts", ...args], {
    budgetMs: ROLL_CLI_BUDGET_MS,
    cwd: process.cwd(),
  });

describe("migrated tool commands", () => {
  it("rejects unknown options and missing values before side effects", async () => {
    expect(() => collectStageEvidence(["--out"])).toThrow();
    expect(() => collectStageEvidence(["--typo"])).toThrow();
    expect(() => compareRollEvidence(["--old", "old.json", "--new"])).toThrow();
    expect(() => compareRollEvidence(["--old", "old.json", "--new", "new.json", "--typo"])).toThrow();
    await expect(produceProjectiveOwnerRelease(["--json"])).rejects.toThrow();
    await expect(produceProjectiveOwnerRelease(["--typo"])).rejects.toThrow();
    expect(() => runHelperAvailabilityContract(["--compare"])).toThrow();
    expect(() => runHelperAvailabilityContract(["--typo"])).toThrow();
    expect(() => parseAnimatedFixtureCli(["--port", "abc"])).toThrow();
    expect(() => parseAnimatedFixtureCli(["--port", "1234", "--typo"])).toThrow();
  });

  it(
    "runs a real roll comparison and writes its report",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "domotion-roll-cli-"));
      const before = join(root, "before.json");
      const after = join(root, "after.json");
      const report = join(root, "report.json");
      const artifact = { environmentFingerprint: { platform: "test" }, reports: [{ area: "text", status: "pass" }] };
      writeFileSync(before, JSON.stringify(artifact));
      writeFileSync(after, JSON.stringify(artifact));
      const result = await runRollCli(["--old", before, "--new", after, "--out", report]);
      expect(result.status, describeChild(result)).toBe(0);
      expect(JSON.parse(readFileSync(report, "utf8"))).toMatchObject({ pass: true, stageChanges: [] });

      // A cited, row-backed review that classifies a stage as a Domotion
      // regression still fails the roll (exit 1), naming the area.
      const changed = join(root, "changed.json");
      const review = join(root, "review.json");
      writeFileSync(changed, JSON.stringify({ ...artifact, reports: [{ area: "text", status: "fail" }] }));
      writeFileSync(
        review,
        JSON.stringify({
          reviewedAreas: {
            text: { sourceRefs: ["chromium/x.cc:1"], updatedRows: ["row"], classification: "domotion-regression" },
          },
        }),
      );
      const regression = await runRollCli(["--old", before, "--new", changed, "--review", review, "--out", report]);
      expect(regression.status, describeChild(regression)).toBe(1);
      expect(JSON.parse(readFileSync(report, "utf8"))).toMatchObject({
        pass: false,
        missingReviews: [],
        regressions: ["text"],
      });

      const invalid = await runRollCli(["--old", before, "--new"]);
      expect(invalid.status, describeChild(invalid)).toBe(2);
      expect(invalid.stderr).toMatch(/--new/);
    },
    testTimeoutFor(ROLL_CLI_BUDGET_MS, ROLL_CLI_BUDGET_MS, ROLL_CLI_BUDGET_MS),
  );
});
