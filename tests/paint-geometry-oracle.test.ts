import { describe, expect, it } from "vitest";
import { blinkCornerLine, runPaintGeometryOracle } from "../tools/paint-geometry-oracle.js";

describe("paint geometry oracle (DM-2297)", () => {
  it("pins Blink's non-square magic-corner geometry", () => {
    const line = blinkCornerLine("top-right", 0, 0, 300, 100);
    expect(line.p0.x).toBeCloseTo(120, 8);
    expect(line.p0.y).toBeCloseTo(140, 8);
    expect(line.p1.x).toBeCloseTo(180, 8);
    expect(line.p1.y).toBeCloseTo(-40, 8);
  });

  it("gates production gradient, mask, and clip builders and proves the corpus moves", () => {
    const report = runPaintGeometryOracle();
    expect(report.movementProven).toBe(true);
    expect(report.rows).toHaveLength(43);
    expect(report.rows.filter((row) => !row.pass)).toEqual([]);
    expect(report.verdict).toBe("exact-logical-agreement");
  });
});
