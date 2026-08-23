import { describe, expect, it } from "vitest";
import {
  runVerticalDecorationLogicalOracle,
  verticalDecorationCases,
} from "../tools/vertical-decoration-oracle.js";

describe("DM-2514 pinned Blink vertical decoration logical oracle", () => {
  const report = runVerticalDecorationLogicalOracle();

  it("joins the complete source matrix to shipped resolution and geometry", () => {
    expect(report.chromiumRevision).toBe("7d859f271cbda744098ac69f44978d4edfa62be3");
    expect(report.geometrySpace).toBe("line-relative-css-px");
    expect(report.rows).toHaveLength(26);
    expect(report.rows.filter((row) => !row.pass)).toEqual([]);
    expect(report.verdict).toBe("source-exact-logical-geometry");
  });

  it("keeps DPR coherent and outside logical decoration formulas", () => {
    expect(report.deviceScaleFactors).toEqual([1, 4]);
    expect(report.logicalGeometryUsesDpr).toBe(false);
    for (const source of verticalDecorationCases().filter((row) => row.deviceScaleFactor === 1)) {
      const dpr1 = report.rows.find((row) => row.id === source.id)!;
      const dpr4 = report.rows.find((row) => row.id === `${source.id}.dpr4`)!;
      expect(dpr4.expected).toEqual(dpr1.expected);
      expect(dpr4.actual).toEqual(dpr1.actual);
    }
    expect(report.rasterPhase).toEqual({
      classification: "separate-browser-observation",
      acceptanceRole: "non-authoritative-for-logical-constants",
    });
  });

  it("is anti-vacuous against side, baseline, flip, zoom, DPR, transform, script, and face mutations", () => {
    expect(Object.keys(report.mutationControls)).toEqual([
      "force-central-under",
      "use-alphabetic-central-offset",
      "drop-flipped-author-offset",
      "skip-effective-zoom",
      "multiply-logical-geometry-by-dpr",
      "reuse-clockwise-for-sideways-lr",
      "derive-script-from-glyph",
      "substitute-wrong-from-font-face",
      "treat-skip-ink-all-as-auto",
      "open-upright-vertical-intercepts",
    ]);
    expect(Object.values(report.mutationControls)).toEqual(Array(10).fill(true));
  });

  it("keeps auto/all exclusions and upright-blob suppression source-distinct", () => {
    expect(report.skipInk).toEqual({
      autoExcludedSlashGapCount: 0,
      allIncludedSlashGapCount: 1,
      uprightProjection: "\u200B",
      rotatedProjection: "/",
      pass: true,
    });
  });

  it("exercises from-font family metrics and locale-over-glyph controls", () => {
    const serif = report.rows.find((row) => row.id === "vrl-sideways-from-font")!;
    const mono = report.rows.find((row) => row.id === "slr-ja-from-font")!;
    expect(serif.expected.thickness).toBe(1.76);
    expect(mono.expected.thickness).toBe(1);
    expect(report.rows.find((row) => row.id === "vrl-ja-A-auto-over")!.expected.flip).toBe(true);
    expect(report.rows.find((row) => row.id === "vrl-en-kana-auto-under")!.expected.flip).toBe(false);
  });
});
