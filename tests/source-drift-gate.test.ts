import { describe, expect, it } from "vitest";
import { compareSourceDrift, type SourceDriftEvidence } from "../src/review/source-drift-gate.js";

const evidence = (revision: string, output: unknown = "Letter", mode: "representative" | "exhaustive" = "representative"): SourceDriftEvidence => ({
  fingerprint: { chromiumRevision: revision, chromiumHarfBuzzRevision: revision, harfbuzzRevision: revision, icuRevision: revision, icuDataSha256: `data-${revision}`, helperBinaries: { icu: `icu-${revision}`, glyph: `glyph-${revision}` }, generatedClassifiers: { script: `script-${revision}`, ignorable: `ignorable-${revision}` } },
  mode,
  unicodeProperties: [{ id: "gc.0041", property: "General_Category", input: "U+0041", output }],
  shapingDecisions: [{ id: "shape.latn", property: "glyph-stream", input: "ffi", output: [1, 2] }],
});

describe("ICU/HarfBuzz source drift gate", () => {
  it("withholds changed property branches until source refs and exact oracle rows are updated", () => {
    const result = compareSourceDrift(evidence("old"), evidence("new", "Lowercase_Letter"));
    expect(result.verdict).toBe("verdict-withheld");
    expect(result.unicodeChanges).toEqual(["gc.0041"]);
    expect(compareSourceDrift(evidence("old"), evidence("new", "Lowercase_Letter"), { sourceRefs: ["icu/uchar.cpp:1"], updatedPropertyRows: ["gc.0041"], updatedShapingRows: [] }).verdict).toBe("comparable");
  });
  it("withholds missing helper/classifier fingerprints and mixed representative/exhaustive profiles", () => {
    const missing = evidence("new"); missing.fingerprint.helperBinaries = {};
    expect(compareSourceDrift(evidence("old"), missing).blockers).toContain("incomplete-source-fingerprint");
    expect(compareSourceDrift(evidence("old"), evidence("new", "Letter", "exhaustive")).blockers).toContain("incomparable-conformance-mode");
  });
  it("does not require row review for a source roll whose exact decisions are unchanged", () => {
    expect(compareSourceDrift(evidence("old"), evidence("new")).verdict).toBe("comparable");
  });
});
