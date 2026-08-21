import { describe, expect, it } from "vitest";
import type { EmbeddedFontBuildDiagnostic } from "../src/render/embedded-font-builder.js";
import type { FixtureTextRunProvenance } from "../src/render/text-run-provenance.js";
import {
  LINUX_UNICODE_RASTER_FLOOR_FIXTURES,
  LINUX_UNICODE_THIN_OUTLINE_CONTROLS,
  compareLinuxUnicodeMutations,
  validateFixtureTextEvidence,
} from "../src/review/linux-unicode-evidence.js";

const FIXTURE = "0900-097F-devanagari";

function evidence(postscriptName = "FreeSans"): FixtureTextRunProvenance {
  return {
    schemaVersion: 1,
    fixture: FIXTURE,
    sourceAuthority: {
      chromium: "7d859f271cbda744098ac69f44978d4edfa62be3",
      harfbuzz: "4de187dd0a915d13c976fa8bd474c084229f3aab",
      skia: "62efacd3",
    },
    transitions: [],
    runs: [{
      fixture: FIXTURE,
      row: 0,
      emitter: "embedded-font",
      sourceText: "।",
      sourceSpan: [0, 1],
      sourceCodepointSpan: [0, 1],
      emittedText: "।",
      mechanism: "system-resolver",
      request: { fontFamily: "sans-serif", fontWeight: 400, fontStretch: 100, fontSizePx: 16, direction: "ltr" },
      selected: {
        fontKey: postscriptName.toLowerCase(), postscriptName, instantiatedPostscriptName: null,
        sourcePath: `/fonts/${postscriptName}.ttf`, faceIndex: 0, variationAxes: null, shapesWithHarfbuzz: true,
      },
      glyphs: [{
        id: 321, cluster: 0, sourceSpan: [0, 1], sourceCodepointSpan: [0, 1],
        xAdvance: 512, yAdvance: 0, xOffset: 0, yOffset: 0,
        sourceOutline: { sha256: "outline", commandCount: 4 },
      }],
      emittedIdentity: "embedded-font:freesans:321",
      finalRepresentation: "embedded-font",
    }],
  };
}

function build(builder: "hb-subset" | "svg2ttf", hints: string[]): EmbeddedFontBuildDiagnostic {
  return {
    instanceKey: "freesans|w=*|src=/fonts/FreeSans.ttf#0|s=0|b=0|sh=0",
    cssFamily: "dmf0", sourcePath: "/fonts/FreeSans.ttf", faceIndex: 0, variationAxes: null,
    selectedBuilder: builder, hintedSourceDisqualifiedReasons: builder === "svg2ttf" ? ["disabled-by-environment"] : [],
    retainedTableTags: ["glyf", ...hints], retainedHintTableTags: hints,
    finalRepresentation: { kind: "embedded-sfnt", mime: "font/ttf", byteLength: 100, sha256: builder },
    affectedGlyphCount: 1, affectedGlyphOccurrenceCount: 1, affectedRunCount: 1,
  };
}

describe("row-scoped Linux Unicode evidence", () => {
  it("pins the exact 24 non-Vedic failures and the thin danda controls", () => {
    expect(LINUX_UNICODE_RASTER_FLOOR_FIXTURES).toHaveLength(24);
    expect(LINUX_UNICODE_RASTER_FLOOR_FIXTURES).not.toContain("1CD0-1CFF-vedic-extensions");
    expect(LINUX_UNICODE_RASTER_FLOOR_FIXTURES).toEqual(expect.arrayContaining([
      "0D00-0D7F-malayalam",
      "3400-4DBF-cjk-unified-ideographs-extension-a.25",
      "AC00-D7AF-hangul-syllables.32",
      "FB50-FDFF-arabic-presentation-forms-a.2",
    ]));
    expect(LINUX_UNICODE_THIN_OUTLINE_CONTROLS).toEqual([0x0964, 0x0965]);
  });

  it("withholds raster-floor acceptance unless both mutations activate and hinting leaves logic exact", () => {
    const baseline = evidence();
    const helperOff = evidence("Unifont");
    const hintOff = evidence();
    expect(validateFixtureTextEvidence(FIXTURE, baseline)).toEqual([]);
    expect(compareLinuxUnicodeMutations(
      baseline, helperOff, hintOff,
      [build("hb-subset", ["cvt ", "fpgm", "prep"])], [build("svg2ttf", [])],
      "baseline-raster", "unhinted-raster",
    )).toEqual(expect.objectContaining({
      selectedFaceRowsMoved: 1,
      hintedLogicalRowsExact: true,
      retainedHintTablesRemoved: true,
      hintedRasterMoved: true,
      verdict: "raster-floor-candidate",
    }));

    expect(compareLinuxUnicodeMutations(
      baseline, helperOff, evidence("Unifont"),
      [build("hb-subset", ["prep"])], [build("svg2ttf", [])],
      "baseline-raster", "unhinted-raster",
    ).verdict).toBe("logical-mismatch");
  });
});
