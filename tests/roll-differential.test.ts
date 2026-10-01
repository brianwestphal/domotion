import { describe, expect, it } from "vitest";
import { compareRollArtifacts, type RollArtifact } from "../src/review/roll-differential.js";
const artifact = (revision: string, payload: unknown): RollArtifact => ({
  environmentFingerprint: {
    chromium: { version: revision, launchFlags: [] },
    host: { os: "linux" },
    runtimes: { chromiumSource: revision, harfbuzzSource: revision, skiaPinned: revision, node: "v22" },
    fingerprint: revision,
  },
  reports: [{ area: "paint", status: "passed" }],
  reportPayloads: { paint: payload },
  visuals: { representative: { digest: String(payload) } },
});
describe("roll differential", () => {
  it("requires source review and updated rows", () => {
    expect(compareRollArtifacts(artifact("old", 1), artifact("new", 2)).missingReviews).toEqual(["paint"]);
    expect(
      compareRollArtifacts(artifact("old", 1), artifact("new", 2), {
        reviewedAreas: {
          paint: { sourceRefs: ["chromium/x.cc:10"], updatedRows: ["row"], classification: "upstream-drift" },
        },
      }).pass,
    ).toBe(true);
  });
  it("rejects incomparable environments", () => {
    const n = artifact("new", 1);
    (n.environmentFingerprint.host as Record<string, unknown>).os = "darwin";
    expect(compareRollArtifacts(artifact("old", 1), n).pass).toBe(false);
  });
  it("allows reviewed representation-only changes", () =>
    expect(
      compareRollArtifacts(artifact("old", 1), artifact("new", 2), {
        reviewedAreas: {
          paint: { sourceRefs: ["skia/x.cc:1"], updatedRows: [], classification: "no-semantic-change" },
        },
      }).pass,
    ).toBe(true));
  it("withholds when only one side carries source-drift evidence", () => {
    const n = artifact("new", 1);
    n.reportPayloads!["icu-harfbuzz-source-drift"] = {};
    expect(compareRollArtifacts(artifact("old", 1), n).pass).toBe(false);
  });

  const goodDrift = {
    fingerprint: {
      chromiumRevision: "a",
      chromiumHarfBuzzRevision: "b",
      harfbuzzRevision: "c",
      icuRevision: "d",
      icuDataSha256: "e",
      helperBinaries: { x: "1" },
      generatedClassifiers: { y: "2" },
    },
    mode: "representative",
    unicodeProperties: [{ id: "u1", property: "p", input: "i", output: 1 }],
    shapingDecisions: [{ id: "s1", property: "p", input: "i", output: 1 }],
  };
  const withDrift = (revision: string, payload: unknown): RollArtifact => {
    const a = artifact(revision, 1);
    a.reportPayloads!["icu-harfbuzz-source-drift"] = payload;
    return a;
  };

  it("compares two well-formed source-drift payloads", () => {
    const result = compareRollArtifacts(withDrift("old", goodDrift), withDrift("new", structuredClone(goodDrift)));
    expect(result.sourceDrift?.verdict).toBe("comparable");
    expect(result.pass).toBe(true);
  });

  it("compares legacy and wrapped source evidence by the same logical fingerprint", () => {
    const wrapped = {
      schemaVersion: 1,
      tool: "source-drift-evidence",
      generatedAt: new Date().toISOString(),
      env: { mode: "representative" },
      data: { ...goodDrift, outcome: "pass" },
    };
    const oldRun = withDrift("old", goodDrift);
    const newRun = withDrift("new", wrapped);
    oldRun.reports.push({ area: "icu-harfbuzz-source-drift", status: "passed" });
    newRun.reports.push({ area: "icu-harfbuzz-source-drift", status: "passed" });
    const result = compareRollArtifacts(oldRun, newRun);
    expect(result.sourceDrift?.verdict).toBe("comparable");
    expect(result.stageChanges).toEqual([]);
    expect(result.pass).toBe(true);
  });

  it("withholds malformed versioned source evidence without throwing", () => {
    const wrapped = {
      schemaVersion: 1,
      tool: "source-drift-evidence",
      generatedAt: new Date().toISOString(),
      env: {},
      data: { ...goodDrift, outcome: "pass" },
    };
    for (const invalid of [
      { ...wrapped, schemaVersion: 2 },
      { ...wrapped, tool: "wrong" },
      { ...wrapped, data: { ...goodDrift, outcome: "fail" } },
      { ...goodDrift, schemaVersion: 2 },
    ]) {
      const result = compareRollArtifacts(withDrift("old", goodDrift), withDrift("new", invalid));
      expect(result.sourceDrift?.blockers).toEqual(["invalid-source-drift-payload"]);
      expect(result.pass).toBe(false);
    }
  });

  it("withholds the verdict on a malformed payload instead of throwing a TypeError", () => {
    for (const bad of [
      {},
      { fingerprint: {} },
      { ...goodDrift, mode: "sometimes" },
      { ...goodDrift, unicodeProperties: "x" },
    ]) {
      let result: ReturnType<typeof compareRollArtifacts> | undefined;
      expect(() => {
        result = compareRollArtifacts(withDrift("old", goodDrift), withDrift("new", bad));
      }).not.toThrow();
      expect(result?.sourceDrift?.blockers).toEqual(["invalid-source-drift-payload"]);
      expect(result?.pass).toBe(false);
    }
  });
});
