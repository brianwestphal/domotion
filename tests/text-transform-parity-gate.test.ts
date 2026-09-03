import { describe, expect, it } from "vitest";

import {
  REQUIRED_TEXT_TRANSFORM_MUTATIONS,
  TEXT_TRANSFORM_CASES,
  TEXT_TRANSFORM_GATE_THRESHOLDS,
  nearestInkColorError,
  validateTextTransformCorpus,
} from "../tools/text-transform-geometry-audit.js";

describe("transformed-text neighboring color comparison", () => {
  it("compares an accepted two-device-pixel displacement with the matching color", () => {
    const target = new Uint8Array([
      255, 0, 0, 255,
      0, 0, 0, 0,
      0, 0, 255, 255,
    ]);
    expect(nearestInkColorError([0, 0, 255, 255], target, 3, 1, 0, 0)).toBe(0);
  });

  it("still rejects a wrong color throughout the accepted neighborhood", () => {
    const target = new Uint8Array([
      255, 0, 0, 255,
      255, 0, 0, 255,
      0, 0, 0, 0,
    ]);
    expect(nearestInkColorError([0, 0, 255, 255], target, 3, 1, 0, 0)).toBeGreaterThan(0.4);
  });
});

describe("transformed-text hard parity gate", () => {
  it("retains the complete source-owned corpus and both HTML-run controls", () => {
    expect(validateTextTransformCorpus()).toEqual([]);
    expect(TEXT_TRANSFORM_CASES).toHaveLength(25);
    expect(TEXT_TRANSFORM_CASES.filter((row) => row.sourceFixture != null).map((row) => row.sourceFixture)).toEqual([
      "external/html-test/21-deep-anisotropic-scale.html",
      "external/html-test/21-deep-transform-origin.html",
    ]);
    expect(TEXT_TRANSFORM_CASES.map((row) => row.id)).toEqual(expect.arrayContaining([
      "identity-negative",
      "translation-negative",
      "uniform-scale-scalar-collision",
      "rotate-scalar-collision",
      "anisotropic-scale",
      "rotate-anisotropic-scale",
      "skew-x",
      "skew-y",
      "reflect-x",
      "reflect-y",
      "nested-asymmetric-origins",
      "border-box-reference",
      "content-box-reference",
      "wrapped-inline-fragments",
      "mixed-face-size",
      "decorations-shadows-stroke",
      "raster-glyph-overlay",
      "rtl-horizontal",
      "vertical-writing",
      "css-zoom-local",
      "same-origin-iframe",
      "affine-matrix3d-negative",
      "projective-positive",
    ]));
    expect(TEXT_TRANSFORM_CASES.find((row) => row.id === "vertical-writing")?.expectedRoute)
      .toBe("affine-vector-or-source-raster");
  });

  it("pins fixed device-space tolerances without platform envelopes", () => {
    expect(TEXT_TRANSFORM_GATE_THRESHOLDS).toEqual({
      quadEpsilonCssPx: 1 / 64,
      matrixEpsilon: 1 / 256,
      maxAffineResidualCssPx: 0.05,
      maxInkEdgeDeltaDevicePx: 4,
      inkNeighborRadiusDevicePx: 2,
      maxInkMismatchFraction: 0.08,
      maxPremultipliedColorError: 0.1,
    });
  });

  it("requires every unsafe scalar/matrix/raster mutation discriminator", () => {
    expect(REQUIRED_TEXT_TRANSFORM_MUTATIONS).toEqual([
      "scalar-collision",
      "drop-off-diagonals",
      "drop-reflection-sign",
      "collapse-reference-box-origin",
      "collapse-wrapped-fragments",
      "fold-zoom-into-matrix",
      "double-apply-transform",
      "force-projective-vector",
    ]);
  });
});
