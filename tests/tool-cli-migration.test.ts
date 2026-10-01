import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { collectStageEvidence } from "../tools/collect-stage-evidence.js";
import { compareRollEvidence } from "../tools/compare-roll-evidence.js";
import { produceProjectiveOwnerRelease } from "../tools/projective-owner-release-producer.js";
import { runHelperAvailabilityContract } from "../tools/helper-availability-contract.js";
import { parseCli as parseAnimatedFixtureCli } from "../tools/animated-image-owner-resource-truth-fixtures.js";

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

  it("runs a real roll comparison and writes its report", () => {
    const root = mkdtempSync(join(tmpdir(), "domotion-roll-cli-"));
    const before = join(root, "before.json");
    const after = join(root, "after.json");
    const report = join(root, "report.json");
    const artifact = { environmentFingerprint: { platform: "test" }, reports: [{ area: "text", status: "pass" }] };
    writeFileSync(before, JSON.stringify(artifact));
    writeFileSync(after, JSON.stringify(artifact));
    const result = spawnSync(
      join(process.cwd(), "node_modules/.bin/tsx"),
      ["tools/compare-roll-evidence.ts", "--old", before, "--new", after, "--out", report],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(report, "utf8"))).toMatchObject({ pass: true, stageChanges: [] });

    const invalid = spawnSync(
      join(process.cwd(), "node_modules/.bin/tsx"),
      ["tools/compare-roll-evidence.ts", "--old", before, "--new"],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(invalid.status).toBe(2);
    expect(invalid.stderr).toMatch(/--new/);
  });
});
