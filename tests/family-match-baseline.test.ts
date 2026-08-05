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
import { join, resolve } from "node:path";
import {
  FAMILY_MATCH_ENV_KEYS, describeRecordedEnvs, readBaselineSet, selectBaseline, writeBaselineSet,
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

// The tests above pin the set SEMANTICS against synthetic fixtures. These pin
// the COMMITTED FILES, which is a different failure mode and the one that is
// invisible: when a set loses the entry for an environment the oracle runs in,
// that comparator silently reverts to refuse-to-judge (exit 3) — which the CI
// wiring deliberately treats as green. The gate then reports success forever
// while grading nothing, exactly the shape of the Windows resolver that shipped
// "default-on" while answering nothing for every codepoint. Nothing else in the
// tree notices, because a declining gate and a passing gate look identical from
// outside the job log.
//
// Keyed off FAMILY_MATCH_ENV_KEYS rather than a local copy so this asserts the
// same fingerprint the comparators select on.
const COMMITTED = [
  { os: "linux", file: "family-match-linux.json", keys: FAMILY_MATCH_ENV_KEYS.linux },
  { os: "windows", file: "family-match-windows.json", keys: FAMILY_MATCH_ENV_KEYS.win32 },
] as const;

describe.each(COMMITTED)("committed $os family-match baseline", ({ file, keys }) => {
  const entries = readBaselineSet(resolve("tests", "baselines", file));

  it("records at least the local arm64 and the x64 CI environment", () => {
    // Both oracles run in two places: an arm64 developer environment (Docker on
    // Apple Silicon / the Parallels VM) and an x64 GitHub runner. An entry per
    // arch is what makes the gate JUDGE in both rather than decline in one.
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(new Set(entries.map((e) => e.meta.env.arch))).toEqual(new Set(["arm64", "x64"]));
  });

  it("gives every recorded environment an entry that selects itself", () => {
    // Also proves no two entries share a fingerprint: a duplicate would make
    // selection order-dependent, and the second copy unreachable.
    for (const entry of entries) {
      const picked = selectBaseline(entries, entry.meta.env, keys);
      expect(picked).not.toBeNull();
      expect(picked?.meta.capturedAt).toBe(entry.meta.capturedAt);
    }
  });

  it("still refuses to judge an environment it has not recorded", () => {
    // The value of an env-keyed baseline is entirely in this refusal — a set
    // that matched anything would compare counts across font inventories.
    const unknown = { ...entries[0].meta.env, fontDigest: "0000000000000000" };
    expect(selectBaseline(entries, unknown, keys)).toBeNull();
  });

  it("carries the fingerprint fields its comparator selects on", () => {
    // A recorded entry missing a key can never match: envMatches compares
    // undefined against the live value, so the gate would decline forever.
    for (const entry of entries) {
      for (const key of keys) expect(entry.meta.env[key]).toBeDefined();
    }
  });
});
