import { describe, expect, it } from "vitest";

import { runMixedReferenceColorSpaceOracle } from "../tools/mixed-reference-color-space-oracle.js";

describe("DM-2535 live mixed reference color-space terminal", () => {
  it("matches pinned intermediate pixels and bounds only the discovered blend-wrapper gap", async () => {
    const report = await runMixedReferenceColorSpaceOracle([1, 2]);
    expect(report.structuralErrors).toEqual([]);
    expect(report.unexpectedFailures).toEqual([]);
    expect(report.boundaries).toHaveLength(6);
    expect(report.boundaries.every((row) => row.pass)).toBe(true);
    expect(report.hostileLogicalControls.every((row) => row.pass)).toBe(true);
    expect(report.rows.every((row) => row.sourceModelMaxChannelError <= 4)).toBe(true);

    const baseGaps = report.rows.filter((row) => row.renderedMaxChannelError > 4);
    const knownBaseGaps = new Set([
      "blend.nonisolated",
      "blend.local-isolated",
    ]);
    expect(baseGaps.every((row) => knownBaseGaps.has(row.id))).toBe(true);
    expect(baseGaps.every((row) => row.renderedMaxChannelError >= 8)).toBe(true);

    const mutationGaps = report.mutations.filter((row) => !row.pass);
    const knownMutationGaps = new Set([
      "nonisolated-drop-blend",
      "isolated-drop-isolation",
      "local-isolated-drop-blend",
    ]);
    expect(mutationGaps.every((row) => knownMutationGaps.has(row.id))).toBe(true);
    expect(mutationGaps.every((row) => row.sourceMutationMaxChannelDistance >= 8)).toBe(true);
    expect(mutationGaps.every((row) => row.renderedMutationMaxChannelDistance <= 4)).toBe(true);

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
    expect(["production-gap", "source-exact"]).toContain(report.verdict);
  }, 360_000);
});
