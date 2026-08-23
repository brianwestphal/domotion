import { describe, expect, it } from "vitest";

import { runGenericFamilySemanticsAudit } from "../tools/generic-family-semantics-audit.js";

describe("live generic-family semantic ownership", () => {
  it("keeps named Courier distinct from CSS monospace in both cache orders", async () => {
    const report = await runGenericFamilySemanticsAudit();
    expect(report.verdict).toBe("confirmed-information-loss");
    expect(report.controls).toEqual({
      completeMatrix: true,
      sourceDistinguishesDeclaredFromGeneric: true,
      rightmostGenericWins: true,
      nonOccupyingGenericsPreserveLegacyEnum: true,
      quotedGenericIsLiteral: true,
      currentRoutingLosesDeclaredCourier: true,
      currentRoutingLosesNonCourierMonospace: true,
      forwardReverseStable: true,
    });
    expect(report.orders).toHaveLength(2);
    for (const order of report.orders) {
      expect(order.rows).toHaveLength(20);
      expect(order.rows.every((row) => row.pass)).toBe(true);
      expect(order.rows.every((row) =>
        row.paintedFaces.length === 1 && row.paintedFaces[0].glyphCount === 1)).toBe(true);
    }
  }, 30_000);
});
