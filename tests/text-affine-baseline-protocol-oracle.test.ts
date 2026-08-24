import { describe, expect, it } from "vitest";

import type { CapturedTextPaintAffine, CapturedTextPaintQuad } from "../src/capture/types.js";
import {
  REQUIRED_TEXT_BASELINE_MUTATIONS,
  TEXT_BASELINE_PROTOCOL_CASES,
  TEXT_BASELINE_PROTOCOL_SOURCE_PINS,
  decodeBlinkTextLineOrigin,
  decodeVerticalRlBaseline,
  mapTextBaselinePoint,
  solveTextBaselineAffine,
  validateTextBaselineProtocolCorpus,
} from "../tools/text-affine-baseline-protocol-oracle.js";

describe("Blink affine text baseline protocol investigation", () => {
  it("pins the Chromium source revision and its HarfBuzz/Skia dependencies", () => {
    expect(TEXT_BASELINE_PROTOCOL_SOURCE_PINS).toEqual({
      chromium: "7d859f271cbda744098ac69f44978d4edfa62be3",
      harfbuzzPinnedByChromium: "511df88b82e697cd2a0f1f0635787aa0b18bddbb",
      skiaPinnedByChromium: "62efacd37737505732dbe3d8daa62abd679626a1",
    });
  });

  it("retains every independently decoded live/capture/emitted discriminator", () => {
    expect(validateTextBaselineProtocolCorpus()).toEqual([]);
    expect(TEXT_BASELINE_PROTOCOL_CASES.map((row) => [row.id, row.expectedDisposition])).toEqual([
      ["fractional-horizontal", "decoded-vector"],
      ["nested-zoom-horizontal", "decoded-vector"],
      ["mixed-script-fragments", "mixed-fragment-correlation-gap"],
      ["vertical-rl-plane", "decoded-vector"],
      ["vertical-lr-plane", "decoded-vector"],
      ["sideways-rl-plane", "decoded-vector"],
      ["sideways-lr-plane", "decoded-vector"],
    ]);
  });

  it("recovers an affine matrix from neutral and live fragment quads", () => {
    const neutral: CapturedTextPaintQuad = [10, 20, 70, 20, 70, 50, 10, 50];
    const expected: CapturedTextPaintAffine = [0.91, 0.27, -0.19, 1.07, 11.25, -7.5];
    const live: CapturedTextPaintQuad = [16.55, 16.6, 71.15, 32.8, 65.45, 64.9, 10.85, 48.7];
    const solved = solveTextBaselineAffine(neutral, live);

    expect(solved).not.toBeNull();
    for (let index = 0; index < expected.length; index++) {
      expect(solved?.[index]).toBeCloseTo(expected[index], 12);
    }
    const neutralBaseline = { x: 70, y: 42 };
    expect(mapTextBaselinePoint(solved!, neutralBaseline)).toEqual(
      mapTextBaselinePoint(expected, neutralBaseline),
    );
  });

  it("keeps vertical-rl line-relative and physical baseline planes distinct", () => {
    expect(decodeVerticalRlBaseline([10, 20, 40, 20, 40, 100, 10, 100], 12)).toEqual({
      lineRelative: { x: 10, y: 32 },
      physical: { x: 28, y: 20 },
    });
  });

  it("keeps the opposite sideways-lr rotation source-distinct", () => {
    expect(decodeBlinkTextLineOrigin([10, 20, 40, 20, 40, 100, 10, 100], 12, "sideways-lr")).toEqual({
      lineRelative: { x: 10, y: 32 },
      rotation: [0, -1, 1, 0, -10, 110],
      physical: { x: 22, y: 100 },
    });
  });

  it("requires every wrong-plane mutation", () => {
    expect(REQUIRED_TEXT_BASELINE_MUTATIONS).toEqual([
      "post-transform-aabb-plus-ascent",
      "ascent-after-affine",
      "snap-after-affine",
      "double-apply-zoom",
      "drop-transform-origin-translation",
      "collapse-mixed-fragments",
      "vertical-horizontal-plane",
      "drop-fragment-relative-top",
    ]);
  });
});
