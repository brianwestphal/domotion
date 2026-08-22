import { describe, expect, it } from "vitest";

import {
  INLINE_SVG_3D_CASES,
  INLINE_SVG_3D_GATE_THRESHOLDS,
  REQUIRED_INLINE_SVG_3D_MUTATIONS,
  validateInlineSvg3dCorpus,
} from "../tools/inline-svg-3d-audit.js";

describe("inline SVG 3D two-leg gate corpus", () => {
  it("retains every required logical/raster route and source-owned family", () => {
    expect(validateInlineSvg3dCorpus()).toEqual([]);
    expect(new Set(INLINE_SVG_3D_CASES.map((row) => row.expectedRoute))).toEqual(new Set([
      "clone-equivalent",
      "outer-raster",
      "promoted-inline-svg-raster",
    ]));
    expect(INLINE_SVG_3D_CASES.map((row) => row.id)).toEqual(expect.arrayContaining([
      "native-transform-attribute-negative",
      "css-affine-matrix3d-fill-box",
      "css-rotate-x-svg-flatten",
      "css-rotate-y-svg-flatten",
      "css-rotate-3d-svg-flatten",
      "css-perspective-function-svg-flatten",
      "css-matrix-non-scaling-stroke",
      "svg-layer-grouping-filter-flattens",
      "svg-layer-grouping-clip-flattens",
      "svg-layer-grouping-mask-flattens",
      "svg-layer-grouping-overflow-flattens",
      "root-svg-own-projective-transform-raster",
      "html-ancestor-perspective-raster",
      "foreign-object-nested-projective-owner-promoted",
    ]));
  });

  it("pins all six unsafe implementation mutations", () => {
    expect(REQUIRED_INLINE_SVG_3D_MUTATIONS).toEqual([
      "literal-matrix3d-attribute",
      "simple-2d-submatrix",
      "non-scaling-stroke-box",
      "html-marker-root-measurement",
      "nested-owner-below-svg-content",
      "property-presence-routing",
    ]);
  });

  it("uses fixed device-space tolerances rather than platform envelopes", () => {
    expect(INLINE_SVG_3D_GATE_THRESHOLDS).toEqual({
      matrixEpsilon: 1 / 256,
      maxAlphaBoundDeltaPx: 2,
      maxAlphaMismatchFraction: 0.05,
      maxRgbaMeanError: 0.03,
    });
  });
});
