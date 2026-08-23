import { describe, expect, it } from "vitest";

import {
  PSEUDO_BACKDROP_CASES,
  PSEUDO_BACKDROP_REQUIRED_STATES,
  runPseudoBackdropSourceOracle,
} from "../tools/pseudo-backdrop-source-oracle.js";

describe("DM-2488 generated-pseudo backdrop source oracle", () => {
  it("owns every DPR1 pseudo boundary and rejects both destructive mutations", async () => {
    const report = await runPseudoBackdropSourceOracle([1]);
    expect(report.requiredStates).toEqual(PSEUDO_BACKDROP_REQUIRED_STATES);
    expect(report.rows).toHaveLength(PSEUDO_BACKDROP_CASES.length);
    expect(report.blockers).toEqual([]);
    expect(report.verdict).toBe("source-exact");
    expect(report.rows.filter((row) => row.expectedRasterOwners === 1)
      .every((row) => row.actualRasterOwners === 1
        && row.noHostWideRaster
        && row.underCapture.discriminated
        && row.overCapture.discriminated
        && row.rasterBeforeVector)).toBe(true);
  }, 120_000);
});
