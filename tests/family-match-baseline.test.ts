// Env-keyed baseline sets for the family-match oracles (docs 110 / 111).
//
// The comparators refuse to judge across an environment change, so one file
// must be able to carry one baseline PER environment (arm64 local + x64 CI).
// These tests pin the set semantics: legacy single-report files read as a
// one-entry set (no migration of committed baselines), selection is
// fingerprint-equality over the tool's key list, and a write replaces only
// its own environment's entry while preserving the others.
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeRecordedEnvs, readBaselineSet, selectBaseline, writeBaselineSet,
  type FamilyMatchReport,
} from "../tools/family-match-baseline.js";

const KEYS = ["platform", "arch", "image", "fontDigest"] as const;

function report(env: Record<string, string | number>, misses: FamilyMatchReport["misses"] = []): FamilyMatchReport {
  return {
    meta: { suite: "family-match", os: "linux", capturedAt: "2026-08-05T00:00:00.000Z", env, weights: [400, 700] },
    summary: { cases: 2, misses: misses.length },
    misses,
  };
}

const ARM = { platform: "linux", arch: "arm64", image: "Ubuntu 24.04.2 LTS", fontDigest: "aaaa" };
const X64 = { platform: "linux", arch: "x64", image: "Ubuntu 24.04.2 LTS", fontDigest: "bbbb" };

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), "fmb-")), "baseline.json");
}

describe("family-match baseline sets", () => {
  it("reads a legacy single-report file as a one-entry set", () => {
    const file = tmpFile();
    writeFileSync(file, JSON.stringify(report(ARM)) + "\n");
    const entries = readBaselineSet(file);
    expect(entries).toHaveLength(1);
    expect(entries[0].meta.env.arch).toBe("arm64");
  });

  it("reads a missing file as an empty set", () => {
    expect(readBaselineSet(tmpFile())).toEqual([]);
  });

  it("selects only an entry whose whole fingerprint matches", () => {
    const entries = [report(ARM), report(X64)];
    expect(selectBaseline(entries, X64, KEYS)?.meta.env.fontDigest).toBe("bbbb");
    expect(selectBaseline(entries, ARM, KEYS)?.meta.env.fontDigest).toBe("aaaa");
    // One differing field is a different environment — no match, the
    // caller's refuse-to-judge case.
    expect(selectBaseline(entries, { ...ARM, fontDigest: "cccc" }, KEYS)).toBeNull();
  });

  it("appends a new environment while preserving the recorded one byte-for-byte", () => {
    const file = tmpFile();
    writeFileSync(file, JSON.stringify(report(ARM, [{ family: "F", css: 700, chrome: "A", ours: "B" }])) + "\n");
    const before = readBaselineSet(file)[0];
    const { replaced, total } = writeBaselineSet(file, report(X64), KEYS);
    expect(replaced).toBe(false);
    expect(total).toBe(2);
    const after = readBaselineSet(file);
    expect(after).toHaveLength(2);
    expect(after[0]).toEqual(before);
    expect(JSON.parse(readFileSync(file, "utf8")).format).toBe("family-match-baseline-set/1");
  });

  it("replaces its own environment's entry in place", () => {
    const file = tmpFile();
    writeBaselineSet(file, report(ARM, [{ family: "F", css: 700, chrome: "A", ours: "B" }]), KEYS);
    writeBaselineSet(file, report(X64), KEYS);
    const { replaced, total } = writeBaselineSet(file, report(ARM), KEYS);
    expect(replaced).toBe(true);
    expect(total).toBe(2);
    const arm = selectBaseline(readBaselineSet(file), ARM, KEYS);
    expect(arm?.misses).toEqual([]);
    // The other environment's entry is untouched.
    expect(selectBaseline(readBaselineSet(file), X64, KEYS)).not.toBeNull();
  });

  it("describes every recorded environment for the refuse-to-judge message", () => {
    const lines = describeRecordedEnvs([report(ARM), report(X64)], KEYS);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("arch=arm64");
    expect(lines[1]).toContain("arch=x64");
  });
});
