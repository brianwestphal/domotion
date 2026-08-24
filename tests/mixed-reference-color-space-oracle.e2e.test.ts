import { describe, expect, it } from "vitest";

import { runMixedReferenceColorSpaceOracle } from "../tools/mixed-reference-color-space-oracle.js";

describe("DM-2535 live mixed reference color-space terminal", () => {
  it("requires every pinned filter/blend stage and mutation to be source-exact", async () => {
    const report = await runMixedReferenceColorSpaceOracle([1, 2]);
    expect(report.structuralErrors).toEqual([]);
    expect(report.unexpectedFailures).toEqual([]);
    expect(report.boundaries).toHaveLength(6);
    expect(report.boundaries.every((row) => row.pass)).toBe(true);
    expect(report.hostileLogicalControls.every((row) => row.pass)).toBe(true);
    expect(report.rows.every((row) => row.sourceModelMaxChannelError <= 4)).toBe(true);

    expect(report.rows.every((row) => row.renderedMaxChannelError <= 4)).toBe(true);
    expect(report.mutations.every((row) => row.pass)).toBe(true);
    expect(report.productionGaps).toEqual([]);

    for (const dpr of [1, 2]) {
      for (const id of [
        "stage.linear-reference",
        "stage.mixed-reference-shorthand",
        "stage.explicit-srgb-boundary",
        "stage.shorthand-first",
        "stage.linear-identity",
        "stage.identity-mixed",
        "stage.identity-explicit",
        "blend.isolated",
      ]) {
        expect(report.rows.find((row) => row.dpr === dpr && row.id === id)?.pass).toBe(true);
      }
    }
    expect(report.verdict).toBe("source-exact");
  }, 360_000);
});
