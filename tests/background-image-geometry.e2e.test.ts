import { describe, expect, it } from "vitest";

import { runUrlBackgroundGeometryAudit } from "../tools/url-background-geometry-audit.js";

describe("Blink URL background tile geometry", () => {
  for (const dpr of [1, 2]) {
    it(`matches independent Chromium marker geometry at DPR ${dpr}`, async () => {
      const report = await runUrlBackgroundGeometryAudit(dpr);
      expect(report.deviceScaleFactor).toBe(dpr);
      expect(report.rows.filter((row) => !row.pass).map((row) => row.id)).toEqual([]);
      expect(report.controls).toMatchObject({
        paletteDetectedEverywhere: true,
        positiveControlsRemainTight: true,
        everyExpectedGapIsDiscriminated: true,
        autoRatioRouteIsExact: true,
        attachmentOwnershipCaptured: true,
        localAttachmentOffsetsCaptured: true,
        sliceRowsAreSourceEquivalent: true,
        sliceGeometryRecordsCaptured: true,
        sliceRestartMutationsDiscriminated: true,
        fragmentPatternsMaterialized: true,
        cyclicLayerRowHasFourImagePatterns: true,
      });

      const byId = new Map(report.rows.map((row) => [row.id, row]));
      for (const id of [
        "auto-width-from-explicit-height",
        "calculated-size",
        "calculated-position-control",
        "space-multiple-tiles-control",
        "space-single-tile-fallback",
        "fixed-viewport-control",
        "fixed-under-transform",
        "local-nonzero-scroll",
        "effective-zoom-auto-intrinsic",
        "cyclic-multiple-layer-lists",
        "wrapped-inline-slice-rtl",
        "wrapped-inline-slice-origin-clip",
        "wrapped-inline-slice-fixed",
        "wrapped-inline-slice-vertical-rl",
        "multicol-block-slice-vertical-rl",
      ]) {
        expect(byId.get(id)?.comparison.labelMismatchFraction, id).toBeLessThanOrEqual(0.005);
        expect(byId.get(id)?.comparison.maxColorBoundDelta, id).toBe(0);
      }

      // External SVG images are independently sampled at the CSS-image and
      // generated-SVG boundaries. Their authored marker edges—not blended
      // seam colors—remain within one physical device pixel.
      for (const id of ["contain-fractional-area", "round-recomputes-auto-axis", "affine-transform-control"]) {
        expect(byId.get(id)?.comparison.maxColorBoundDelta, id).toBeLessThanOrEqual(1);
      }

      // DM-2365: every sliced fragment has a source-owned stitched box and a
      // materialized SVG pattern. Replacing that box with clone-style physical
      // fragments must be visibly rejected; viewport-fixed attachment is the
      // deliberate exception because Blink ignores the stitched box there.
      for (const id of [
        "wrapped-inline-slice",
        "wrapped-inline-slice-rtl",
        "wrapped-inline-slice-origin-clip",
        "wrapped-inline-slice-vertical-rl",
        "multicol-block-slice",
        "multicol-block-slice-vertical-rl",
      ]) {
        const row = byId.get(id)!;
        expect(row.expectedRoute, id).toBe("source-equivalent");
        expect(row.captured?.fragments?.length, id).toBeGreaterThan(1);
        expect(row.patterns.length, id).toBe(row.captured?.fragments?.length);
        expect(row.restartMutation?.discriminated, id).toBe(true);
      }
      expect(byId.get("wrapped-inline-slice-fixed")?.restartMutation).toBeUndefined();
    }, 60_000);
  }
});
