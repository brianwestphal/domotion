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
      ]) {
        expect(byId.get(id)?.comparison.labelMismatchFraction, id).toBe(0);
        expect(byId.get(id)?.comparison.maxColorBoundDelta, id).toBe(0);
      }

      // External SVG images are independently sampled at the CSS-image and
      // generated-SVG boundaries. Their authored marker edges—not blended
      // seam colors—remain within one physical device pixel.
      for (const id of ["contain-fractional-area", "round-recomputes-auto-axis", "affine-transform-control"]) {
        expect(byId.get(id)?.comparison.maxColorBoundDelta, id).toBeLessThanOrEqual(1);
      }

      // Fragment continuation is a separate owner (DM-2365): retaining these
      // strict negatives prevents this tile-geometry route from silently
      // claiming slice geometry it does not implement.
      expect(byId.get("wrapped-inline-slice")?.expectedRoute).toBe("current-gap");
      expect(byId.get("multicol-block-slice")?.expectedRoute).toBe("current-gap");
    }, 60_000);
  }
});
