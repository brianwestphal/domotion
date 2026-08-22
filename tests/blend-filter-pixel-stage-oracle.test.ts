import { describe, expect, it } from "vitest";

import {
  BLEND_FILTER_SOURCE_PINS,
  BLUR_IDENTITY_SIGMA,
  BLUR_KERNEL_RADIUS_MULTIPLIER,
  MUTATION_MIN_CHANNEL_DISTANCE,
  STAGE_CHANNEL_TOLERANCE,
  applyColorFilters,
  blend,
  blendFilterFixtureHtml,
  blendModes,
  premultiply,
} from "../tools/blend-filter-pixel-stage-oracle.js";

describe("DM-2360 source-derived blend/filter stages", () => {
  it("pins the Chromium handoff and its DEPS-owned Skia revision", () => {
    expect(BLEND_FILTER_SOURCE_PINS.chromium).toBe("7d859f271cbda744098ac69f44978d4edfa62be3");
    expect(BLEND_FILTER_SOURCE_PINS.skiaPinnedByChromium).toBe("62efacd37737505732dbe3d8daa62abd679626a1");
    expect(BLUR_IDENTITY_SIGMA).toBe(.03);
    expect(BLUR_KERNEL_RADIUS_MULTIPLIER).toBe(3);
    expect(STAGE_CHANNEL_TOLERANCE).toBe(4);
    expect(MUTATION_MIN_CHANNEL_DISTANCE).toBe(8);
  });

  it("transcribes premultiplied source-over and multiply instead of straight-alpha arithmetic", () => {
    const source = { r: .2, g: .7, b: .9, a: .6 };
    const destination = { r: .8, g: .3, b: .1, a: .75 };
    expect(premultiply(source)).toEqual({ r: .12, g: .42, b: .54, a: .6 });

    const normal = blend("normal", source, destination);
    expect(normal.a).toBeCloseTo(.9, 12);
    expect(normal.r).toBeCloseTo((.12 + .6 * .4) / .9, 12);

    const multiply = blend("multiply", source, destination);
    const expectedPremultipliedRed = .12 * .6 + .12 * .25 + .6 * .4;
    expect(multiply.r).toBeCloseTo(expectedPremultipliedRed / .9, 12);
  });

  it("keeps every supported Skia blend stage bounded for partial-alpha inputs", () => {
    const source = { r: .149, g: .671, b: .878, a: .65 };
    const destination = { r: .769, g: .322, b: .169, a: 1 };
    expect(blendModes).toHaveLength(17);
    for (const mode of blendModes) {
      const result = blend(mode, source, destination);
      expect(result.a, mode).toBeGreaterThanOrEqual(0);
      expect(result.a, mode).toBeLessThanOrEqual(1);
      for (const channel of [result.r, result.g, result.b]) {
        expect(channel, mode).toBeGreaterThanOrEqual(0);
        expect(channel, mode).toBeLessThanOrEqual(1);
      }
    }
  });

  it("applies shorthand matrices/transfers in list order and keeps opacity on alpha", () => {
    const input = { r: .15, g: .67, b: .88, a: .65 };
    const forward = applyColorFilters(input, [
      { type: "invert", amount: .3 },
      { type: "sepia", amount: .7 },
      { type: "contrast", amount: .8 },
    ]);
    const reverse = applyColorFilters(input, [
      { type: "contrast", amount: .8 },
      { type: "sepia", amount: .7 },
      { type: "invert", amount: .3 },
    ]);
    expect(forward).not.toEqual(reverse);
    expect(applyColorFilters(input, [{ type: "opacity", amount: .4 }])).toMatchObject({
      r: input.r, g: input.g, b: input.b, a: .26,
    });
  });

  it("ships a composed fixture with every blend mode and both raster-boundary controls", () => {
    const fixture = blendFilterFixtureHtml();
    for (const mode of blendModes) expect(fixture).toContain(`data-probe="blend.${mode}"`);
    expect(fixture).toContain('data-domotion-anim="boundary-backdrop"');
    expect(fixture).toContain('data-domotion-anim="boundary-convolve"');
    expect(fixture).toContain('data-domotion-anim="boundary-url-color"');
    expect(fixture).toContain('data-domotion-anim="boundary-native-convolve"');
    expect(fixture).toContain("feConvolveMatrix");
  });
});
