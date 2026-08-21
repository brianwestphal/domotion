import { describe, expect, it } from "vitest";
import { runSyntheticBoldPaintOracle } from "../tools/synthetic-bold-paint-oracle.js";

describe("synthetic-bold paint-stage oracle", () => {
  const report = runSyntheticBoldPaintOracle();

  it("matches the pinned Skia rule over the complete control matrix", () => {
    expect(report.rows).toHaveLength(5400);
    expect(report.failures).toBe(0);
    expect(new Set(report.rows.map((row) => row.platform))).toEqual(new Set(["darwin", "linux", "win32"]));
    expect(new Set(report.rows.map((row) => row.face.kind))).toEqual(new Set(["static", "variable"]));
    expect(new Set(report.rows.map((row) => row.hinting))).toEqual(new Set(["unhinted", "light", "native-full"]));
    expect(new Set(report.rows.map((row) => row.fontSizePx))).toEqual(new Set([8, 9, 18, 36, 72]));
    expect(new Set(report.rows.map((row) => row.transform.id))).toEqual(new Set([
      "identity", "uniform-zoom", "anisotropic-rotate",
    ]));
  });

  it("keeps every hinting mode's outline record source-owned", () => {
    for (const row of report.rows) {
      expect(row.sourceOutlineRecord).toEqual({
        owner: "selected-face-glyph", hinting: row.hinting, mutation: "none",
      });
      expect(row.actual.outline).toBe("source");
    }
  });

  it("mutation control rejects every retired opaque stroke-first outline branch", () => {
    expect(report.retiredMutationRows).toBeGreaterThan(0);
    expect(report.retiredMutationMoved).toBe(report.retiredMutationRows);
    expect(report.retiredProductionSymbolsGone).toBe(true);
  });
});
