import { describe, expect, it } from "vitest";
import type { EmbeddedFontBuildDiagnostic } from "../src/render/embedded-font-builder.js";
import type { FixtureTextRunProvenance } from "../src/render/text-run-provenance.js";
import {
  LINUX_UNICODE_RASTER_FLOOR_FIXTURES,
  LINUX_UNICODE_FACE_MUTATION_VALIDATED_FIXTURES,
  LINUX_UNICODE_SELECTION_REJECT_VALIDATED_FIXTURES,
  LINUX_UNICODE_THIN_OUTLINE_CONTROLS,
  LINUX_VEDIC_DOTTED_CIRCLE_FIXTURE,
  LINUX_VEDIC_DOTTED_CIRCLE_RECORDS,
  compareLinuxUnicodeMutations,
  classifyLinuxUnicodeFixtureEvidence,
  hasLinuxUnicodeFaceMutationEvidence,
  hasLinuxUnicodeHelperOffFaceMutationEvidence,
  hasLinuxUnicodeSelectionRejectEvidence,
  shouldCollectLinuxUnicodeTextEvidence,
  validateFixtureTextEvidence,
  validateLinuxVedicDottedCircleEvidence,
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
    runs: [
      {
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
          fontKey: postscriptName.toLowerCase(),
          postscriptName,
          instantiatedPostscriptName: null,
          sourcePath: `/fonts/${postscriptName}.ttf`,
          faceIndex: 0,
          variationAxes: null,
          shapesWithHarfbuzz: true,
        },
        glyphs: [
          {
            id: 321,
            cluster: 0,
            sourceSpan: [0, 1],
            sourceCodepointSpan: [0, 1],
            xAdvance: 512,
            yAdvance: 0,
            xOffset: 0,
            yOffset: 0,
            sourceOutline: { sha256: "outline", commandCount: 4 },
          },
        ],
        emittedIdentity: "embedded-font:freesans:321",
        finalRepresentation: "embedded-font",
      },
    ],
  };
}

function build(builder: "hb-subset" | "svg2ttf", hints: string[]): EmbeddedFontBuildDiagnostic {
  return {
    instanceKey: "freesans|w=*|src=/fonts/FreeSans.ttf#0|s=0|b=0|sh=0",
    cssFamily: "dmf0",
    sourcePath: "/fonts/FreeSans.ttf",
    faceIndex: 0,
    variationAxes: null,
    selectedBuilder: builder,
    hintedSourceDisqualifiedReasons: builder === "svg2ttf" ? ["disabled-by-environment"] : [],
    retainedTableTags: ["glyf", ...hints],
    retainedHintTableTags: hints,
    finalRepresentation: { kind: "embedded-sfnt", mime: "font/ttf", byteLength: 100, sha256: builder },
    affectedGlyphCount: 1,
    affectedGlyphOccurrenceCount: 1,
    affectedRunCount: 1,
  };
}

describe("row-scoped Linux Unicode evidence", () => {
  it("pins the exact 24 non-Vedic failures and the thin danda controls", () => {
    expect(LINUX_UNICODE_RASTER_FLOOR_FIXTURES).toHaveLength(24);
    expect(LINUX_UNICODE_RASTER_FLOOR_FIXTURES).not.toContain("1CD0-1CFF-vedic-extensions");
    expect(LINUX_UNICODE_RASTER_FLOOR_FIXTURES).toEqual(
      expect.arrayContaining([
        "0D00-0D7F-malayalam",
        "3400-4DBF-cjk-unified-ideographs-extension-a.25",
        "AC00-D7AF-hangul-syllables.32",
        "FB50-FDFF-arabic-presentation-forms-a.2",
      ]),
    );
    expect(LINUX_UNICODE_THIN_OUTLINE_CONTROLS).toEqual([0x0964, 0x0965]);
  });

  it("admits every row through exactly one measured face-selection control", () => {
    // 14 rows move under helper-off (run 36809436632); the other ten move only
    // under the fontconfig selection-reject arm. The two sets partition the
    // closed 24-row corpus.
    expect(LINUX_UNICODE_FACE_MUTATION_VALIDATED_FIXTURES).toHaveLength(14);
    expect(new Set(LINUX_UNICODE_FACE_MUTATION_VALIDATED_FIXTURES).size).toBe(14);
    expect(LINUX_UNICODE_SELECTION_REJECT_VALIDATED_FIXTURES).toEqual([
      "0080-00FF-latin-1-supplement",
      "0100-017F-latin-extended-a",
      "02B0-02FF-spacing-modifier-letters",
      "0870-089F-arabic-extended-b",
      "0900-097F-devanagari",
      "0D00-0D7F-malayalam",
      "1E00-1EFF-latin-extended-additional",
      "1F00-1FFF-greek-extended",
      "A720-A7FF-latin-extended-d",
      "FB50-FDFF-arabic-presentation-forms-a.2",
    ]);
    for (const fixture of LINUX_UNICODE_RASTER_FLOOR_FIXTURES) {
      expect(
        Number(hasLinuxUnicodeHelperOffFaceMutationEvidence(fixture)) +
          Number(hasLinuxUnicodeSelectionRejectEvidence(fixture)),
        fixture,
      ).toBe(1);
    }
    expect(LINUX_UNICODE_RASTER_FLOOR_FIXTURES.filter((f) => !hasLinuxUnicodeFaceMutationEvidence(f))).toEqual([]);
    for (const fixture of LINUX_UNICODE_RASTER_FLOOR_FIXTURES) {
      const textRunEvidence = evidence();
      textRunEvidence.fixture = fixture;
      textRunEvidence.runs[0].fixture = fixture;
      const hintedBuild = build("hb-subset", ["prep"]);
      if (fixture === "4E00-9FFF-cjk-unified-ideographs.30") {
        textRunEvidence.runs[0].selected = {
          ...textRunEvidence.runs[0].selected,
          fontKey: "sysfb:WenQuanYiZenHeiMono",
          postscriptName: "WenQuanYiZenHeiMono",
          sourcePath: "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
          faceIndex: 1,
        };
        hintedBuild.sourcePath = "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc";
        hintedBuild.faceIndex = 1;
      }
      const result = classifyLinuxUnicodeFixtureEvidence({
        platform: "linux",
        suite: "html-test-unicode",
        fixture,
        diffPct: 0.5,
        textRunEvidence,
        embeddedFontBuilds: [hintedBuild],
      });
      expect(result != null, fixture).toBe(hasLinuxUnicodeFaceMutationEvidence(fixture));
    }
  });

  it("keeps structural Vedic evidence separate and pins all exact affected streams", () => {
    expect(LINUX_VEDIC_DOTTED_CIRCLE_RECORDS).toHaveLength(14);
    expect(shouldCollectLinuxUnicodeTextEvidence(LINUX_VEDIC_DOTTED_CIRCLE_FIXTURE)).toBe(true);
    expect(LINUX_UNICODE_RASTER_FLOOR_FIXTURES).not.toContain(LINUX_VEDIC_DOTTED_CIRCLE_FIXTURE);
    const runs: FixtureTextRunProvenance["runs"] = LINUX_VEDIC_DOTTED_CIRCLE_RECORDS.map((record, row) => ({
      fixture: LINUX_VEDIC_DOTTED_CIRCLE_FIXTURE,
      row,
      emitter: "embedded-font",
      sourceText: String.fromCodePoint(record.codepoint),
      sourceSpan: [0, 1],
      sourceCodepointSpan: [0, 1],
      emittedText: String.fromCodePoint(record.codepoint),
      mechanism: "system-resolver",
      request: {
        fontFamily: "fixture",
        fontWeight: 400,
        fontStretch: 100,
        fontSizePx: 32,
        direction: "ltr",
        script: record.script,
      },
      selected: {
        fontKey: `sysfb:${record.postscriptName}`,
        postscriptName: record.postscriptName,
        instantiatedPostscriptName: null,
        sourcePath: record.sourcePath,
        faceIndex: 0,
        variationAxes: null,
        shapesWithHarfbuzz: true,
      },
      glyphs: record.glyphs.map((glyph) => ({
        ...glyph,
        sourceSpan: [0, 1],
        sourceCodepointSpan: [0, 1],
        sourceOutline: null,
      })),
      emittedIdentity: `embedded-font:${record.postscriptName}`,
      finalRepresentation: "embedded-font",
    }));
    runs.push({
      ...runs[0],
      row: runs.length,
      sourceText: "\u1CD0",
      emittedText: "\u1CD0",
      request: { ...runs[0].request, script: "Zyyy" },
      glyphs: [
        {
          id: 3401,
          cluster: 0,
          sourceSpan: [0, 1],
          sourceCodepointSpan: [0, 1],
          xAdvance: 0,
          yAdvance: 0,
          xOffset: 0,
          yOffset: 0,
          sourceOutline: null,
        },
      ],
    });
    const exact: FixtureTextRunProvenance = {
      schemaVersion: 1,
      fixture: LINUX_VEDIC_DOTTED_CIRCLE_FIXTURE,
      sourceAuthority: evidence().sourceAuthority,
      runs,
      transitions: [],
    };
    expect(validateLinuxVedicDottedCircleEvidence(exact, ["FreeSans:20", "FreeSerif:37"])).toEqual([]);
    exact.runs[0].glyphs[0].xAdvance++;
    expect(validateLinuxVedicDottedCircleEvidence(exact, ["FreeSans:20", "FreeSerif:37"])).toContain(
      "U+1CD1 glyph stream differs",
    );
  });

  it("withholds raster-floor acceptance unless both mutations activate and hinting leaves logic exact", () => {
    const baseline = evidence();
    const helperOff = evidence("Unifont");
    const hintOff = evidence();
    expect(validateFixtureTextEvidence(FIXTURE, baseline)).toEqual([]);
    expect(
      compareLinuxUnicodeMutations(
        baseline,
        helperOff,
        hintOff,
        [build("hb-subset", ["cvt ", "fpgm", "prep"])],
        [build("svg2ttf", [])],
        "baseline-raster",
        "unhinted-raster",
      ),
    ).toEqual(
      expect.objectContaining({
        selectedFaceRowsMoved: 1,
        hintedLogicalRowsExact: true,
        retainedHintTablesRemoved: true,
        hintedRasterMoved: true,
        verdict: "raster-floor-candidate",
      }),
    );

    expect(
      compareLinuxUnicodeMutations(
        baseline,
        helperOff,
        evidence("Unifont"),
        [build("hb-subset", ["prep"])],
        [build("svg2ttf", [])],
        "baseline-raster",
        "unhinted-raster",
      ).verdict,
    ).toBe("logical-mismatch");
  });
});
