import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { clearGlyphHelperCache, createGlyphHelperFont, isGlyphHelperAvailable } from "./glyph-helper.js";
import {
  __clearGlyphFallbackCaches,
  clearFontResolutionCaches,
  coreTextDesignOutlineEligibility,
  getFontInstance,
  getFontSourceInfo,
  resolveGlyphCommands,
  type FontSourceInfo,
} from "./font-resolution.js";

const SFNS = "/System/Library/Fonts/SFNS.ttf";
const TEXT = "zoom2!";
const BASE_AXES = { wdth: 100, opsz: 17, GRAD: 400, wght: 700 };
const MUTATION_AXES = { ...BASE_AXES, opsz: 26 };

const exactSource: FontSourceInfo = {
  path: SFNS,
  postscriptName: ".SFNS-Regular",
  faceIndex: 0,
  nameMatched: true,
  variationAxes: { ...BASE_AXES },
};

describe("CoreText design-outline eligibility (DM-2567)", () => {
  it.each([
    ["authenticated macOS variable file", exactSource, "darwin", "eligible"],
    ["other platform", exactSource, "linux", "not-darwin"],
    ["no source", null, "darwin", "source-unavailable"],
    ["static source", { ...exactSource, variationAxes: null }, "darwin", "static-source"],
    ["unknown collection member", { ...exactSource, faceIndex: null }, "darwin", "face-index-unknown"],
    ["unmatched face", { ...exactSource, nameMatched: false }, "darwin", "face-name-unmatched"],
    ["unnamed nonzero member", { ...exactSource, postscriptName: undefined, faceIndex: 2 }, "darwin", "face-reopen-unaddressable"],
  ] as const)("classifies %s without widening the native route", (_label, source, platform, expected) => {
    expect(coreTextDesignOutlineEligibility(source, platform)).toBe(expected);
  });
});

const macHelperAvailable = process.platform === "darwin"
  && existsSync(SFNS)
  && isGlyphHelperAvailable();
const describeMacHelper = macHelperAvailable ? describe : describe.skip;

describeMacHelper("SFNS production outline ownership (DM-2567)", () => {
  it("uses exact CoreText commands for every routed gid across two cold/warm pairs and an opsz mutation", () => {
    const coldWarmEvidence: Array<{ base: unknown[]; mutation: unknown[] }> = [];

    for (let coldIteration = 0; coldIteration < 2; coldIteration++) {
      clearFontResolutionCaches();
      __clearGlyphFallbackCaches();

      const iteration: { base: unknown[]; mutation: unknown[] } = { base: [], mutation: [] };
      for (const [label, axes] of [["base", BASE_AXES], ["mutation", MUTATION_AXES]] as const) {
        const font = getFontInstance("sf-pro", 700, 13, 0, axes, 100, true);
        expect(font, `${label} font`).not.toBeNull();
        const source = getFontSourceInfo(font);
        expect(source).toMatchObject({
          path: SFNS,
          faceIndex: 0,
          nameMatched: true,
          variationAxes: axes,
        });
        expect(coreTextDesignOutlineEligibility(source)).toBe("eligible");

        const native = createGlyphHelperFont({ fontPath: SFNS, variations: axes });
        expect(native, `${label} CoreText face`).not.toBeNull();
        const layout = font!.layout(TEXT);
        expect(layout.glyphs.map((glyph) => glyph.id)).toEqual([969, 815, 815, 795, 1310, 1377]);

        const cold = layout.glyphs.map((glyph, index) => resolveGlyphCommands(
          glyph,
          "sf-pro",
          700,
          13,
          0,
          [TEXT.codePointAt(index)!],
          font!,
        ));
        const warm = layout.glyphs.map((glyph, index) => resolveGlyphCommands(
          glyph,
          "sf-pro",
          700,
          13,
          0,
          [TEXT.codePointAt(index)!],
          font!,
        ));
        const expected = layout.glyphs.map((glyph) => native!.getGlyph(glyph.id).path.commands);

        expect(cold.map((result) => result.disposition)).toEqual(Array(6).fill("helper-outline"));
        expect(cold.map((result) => result.commands)).toEqual(expected);
        expect(warm).toEqual(cold);
        iteration[label] = cold.map((result) => result.commands);
      }
      coldWarmEvidence.push(iteration);
    }

    expect(coldWarmEvidence[1]).toEqual(coldWarmEvidence[0]);
    expect(coldWarmEvidence[0].base).not.toEqual(coldWarmEvidence[0].mutation);
    expect((coldWarmEvidence[0].base[0] as Array<{ args: number[] }>)[0].args[0]).toBe(120.5);
  });

  it("fails closed instead of returning fontkit commands when the helper disappears", () => {
    const font = getFontInstance("sf-pro", 700, 13, 0, BASE_AXES, 100, true)!;
    const glyph = font.layout("z").glyphs[0];
    const saved = process.env.DOMOTION_DISABLE_HELPER;
    try {
      process.env.DOMOTION_DISABLE_HELPER = "1";
      clearGlyphHelperCache();
      __clearGlyphFallbackCaches();
      expect(resolveGlyphCommands(glyph, "sf-pro", 700, 13, 0, [0x7a], font)).toEqual({
        commands: [],
        disposition: "helper-unavailable",
      });
    } finally {
      if (saved == null) delete process.env.DOMOTION_DISABLE_HELPER;
      else process.env.DOMOTION_DISABLE_HELPER = saved;
      clearGlyphHelperCache();
      __clearGlyphFallbackCaches();
    }
  });
});
