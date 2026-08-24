import { describe, expect, it } from "vitest";

import { MUTATION_MIN_CHANNEL_DISTANCE, STAGE_CHANNEL_TOLERANCE } from "../tools/blend-filter-pixel-stage-oracle.js";
import {
  MIXED_CHANNEL_TRANSFER_FACTS,
  MIXED_COLOR_SPACE_SOURCE_PINS,
  MIXED_SOURCE,
  linearChannelToSrgb,
  mixedReferenceColorSpaceFixtureHtml,
  srgbChannelToLinear,
  srgbToLinear,
  traceExplicitSrgbBoundary,
  tracePinnedMixedPipeline,
  wronglyDecodePremultiplied,
} from "../tools/mixed-reference-color-space-oracle.js";

const codeDistance = (left: number, right: number): number => Math.abs(Math.round(left * 255) - Math.round(right * 255));

describe("DM-2535 pinned mixed reference color-space stages", () => {
  it("pins Chromium, its DEPS-owned Skia revision, and the unchanged stage bounds", () => {
    expect(MIXED_COLOR_SPACE_SOURCE_PINS).toEqual({
      chromium: "7d859f271cbda744098ac69f44978d4edfa62be3",
      skiaPinnedByChromium: "62efacd37737505732dbe3d8daa62abd679626a1",
    });
    expect(STAGE_CHANNEL_TOLERANCE).toBe(4);
    expect(MUTATION_MIN_CHANNEL_DISTANCE).toBe(8);
  });

  it("fails closed across a Chromium roll until the missing-transition model is reviewed", async () => {
    const previous = process.env.DOMOTION_CHROMIUM_REVISION;
    process.env.DOMOTION_CHROMIUM_REVISION = "future-unreviewed-revision";
    try {
      const { runMixedReferenceColorSpaceOracle } = await import("../tools/mixed-reference-color-space-oracle.js");
      const report = await runMixedReferenceColorSpaceOracle([]);
      expect(report.chromiumRollDiscriminator.pass).toBe(false);
      expect(report.structuralErrors).toContain("chromium-roll:future-unreviewed-revision");
      expect(report.verdict).toBe("unexpected-drift");
    } finally {
      if (previous == null) delete process.env.DOMOTION_CHROMIUM_REVISION;
      else process.env.DOMOTION_CHROMIUM_REVISION = previous;
    }
  });

  it("transcribes the pinned sRGB channel transfer at both breakpoints", () => {
    expect(MIXED_CHANNEL_TRANSFER_FACTS.srgbHalfToLinear).toBeCloseTo(.21404114048223255, 14);
    expect(MIXED_CHANNEL_TRANSFER_FACTS.linearHalfToSrgb).toBeCloseTo(.7353569830524495, 14);
    expect(srgbChannelToLinear(.04045)).toBeCloseTo(.0031308049535603713, 14);
    expect(linearChannelToSrgb(.0031308)).toBeCloseTo(.040449936, 12);
    expect(linearChannelToSrgb(srgbChannelToLinear(.73))).toBeCloseTo(.73, 14);
  });

  it("records every straight and premultiplied surface around the missing transition", () => {
    const trace = tracePinnedMixedPipeline();
    expect(trace.map((stage) => stage.id)).toEqual([
      "source-srgb",
      "reference-input-linear",
      "reference-output-linear",
      "shorthand-without-transition",
      "terminal-srgb",
    ]);
    expect(trace[3].interpolationSpace).toBe("linearRGB-values/shorthand-assumes-sRGB");
    for (const stage of trace) {
      expect(stage.premultiplied.a).toBe(stage.straight.a);
      expect(stage.premultiplied.r).toBeCloseTo(stage.straight.r * stage.straight.a, 14);
      expect(stage.premultiplied.g).toBeCloseTo(stage.straight.g * stage.straight.a, 14);
      expect(stage.premultiplied.b).toBeCloseTo(stage.straight.b * stage.straight.a, 14);
    }
  });

  it("kills early-conversion, wrong-order, and premultiplied-transfer models", () => {
    const pinned = tracePinnedMixedPipeline().at(-1)!;
    const explicit = traceExplicitSrgbBoundary().at(-1)!;
    expect(Math.max(
      codeDistance(pinned.straight.r, explicit.straight.r),
      codeDistance(pinned.straight.g, explicit.straight.g),
      codeDistance(pinned.straight.b, explicit.straight.b),
    )).toBeGreaterThanOrEqual(MUTATION_MIN_CHANNEL_DISTANCE);

    const correctLinear = srgbToLinear(MIXED_SOURCE);
    const wrongLinear = wronglyDecodePremultiplied(MIXED_SOURCE);
    expect(Math.max(
      codeDistance(correctLinear.r, wrongLinear.r),
      codeDistance(correctLinear.g, wrongLinear.g),
      codeDistance(correctLinear.b, wrongLinear.b),
    )).toBeGreaterThanOrEqual(MUTATION_MIN_CHANNEL_DISTANCE);
  });

  it("ships identity, explicit-boundary, ordering, blend, and isolation controls", () => {
    const fixture = mixedReferenceColorSpaceFixtureHtml();
    expect(fixture).toContain('id="linear-matrix" color-interpolation-filters="linearRGB"');
    expect(fixture).toContain('id="linear-identity" color-interpolation-filters="linearRGB"');
    expect(fixture).toContain('id="srgb-identity" color-interpolation-filters="sRGB"');
    for (const probe of [
      "stage.mixed-reference-shorthand",
      "stage.explicit-srgb-boundary",
      "stage.shorthand-first",
      "stage.identity-mixed",
      "stage.identity-explicit",
      "blend.nonisolated",
      "blend.isolated",
      "blend.local-isolated",
    ]) expect(fixture).toContain(`data-probe="${probe}"`);
  });
});
