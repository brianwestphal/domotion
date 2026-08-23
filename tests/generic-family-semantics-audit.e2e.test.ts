import { describe, expect, it } from "vitest";

import { runGenericFamilySemanticsAudit } from "../tools/generic-family-semantics-audit.js";

describe("live generic-family semantic ownership", () => {
  it("keeps source enum, platform routing, terminal activation, and cache order exact", async () => {
    const report = await runGenericFamilySemanticsAudit();
    expect(report.schemaVersion).toBe(2);
    expect(report.verdict).toBe("source-exact");
    expect(report.sourceFingerprints.match).toBe(true);
    expect(report.controls).toEqual({
      completeMatrix: true,
      sourcePinsMatch: true,
      sourceEnumExact: true,
      platformCandidateOrderExact: true,
      terminalQuestionOrderExact: true,
      terminalOwnerOrderExact: true,
      terminalActivationExact: true,
      productionRoutingExact: true,
      cacheIdentityExact: true,
      sourceDistinguishesDeclaredFromGeneric: true,
      rightmostGenericWins: true,
      nonOccupyingGenericsPreserveLegacyEnum: true,
      quotedGenericIsLiteral: true,
      keyDerivedFalsePositiveDetected: true,
      keyDerivedFalseNegativeDetected: true,
      forwardReverseCacheStable: true,
      paintedFaceComplete: true,
    });
    expect(report.orders).toHaveLength(2);
    for (const order of report.orders) {
      expect(order.rows).toHaveLength(26);
      expect(order.rows.every((row) => row.pass)).toBe(true);
      expect(order.rows.every((row) =>
        row.paintedFaces.length === 1 && row.paintedFaces[0].glyphCount === 1)).toBe(true);
    }
  }, 30_000);
});
