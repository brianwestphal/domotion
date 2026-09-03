import { describe, expect, it } from "vitest";

import {
  FONT_PALETTE_CASES,
  FONT_PALETTE_FIXTURE_SHA256,
  FONT_PALETTE_SOURCE_PINS,
  adjudicateNativePaletteRow,
  classifyPaletteAudit,
  expectedPaletteColors,
  opaquePaletteColorsWithinTolerance,
  readPaletteSourceFacts,
  type NativePaletteRow,
  type ProductionOrderEvidence,
} from "../tools/font-palette-ownership-audit.js";

const sha = (value: string): string => value.repeat(64);

function nativeRow(): NativePaletteRow {
  const spec = FONT_PALETTE_CASES.find((row) => row.id === "named-base2")!;
  return adjudicateNativePaletteRow({
    id: "named-base2", dpr: 1, computedFontPalette: "--base2",
    cssomRule: { name: "--base2", fontFamily: "DomotionPaletteAudit", basePalette: "2", overrideColors: "" },
    sourceGlyphId: 35, paintedFamilyDisplayName: "Ahem", paintedPostscriptDisplayName: "Ahem",
    isCustomFont: true, paintedGlyphCount: 1,
    expectedColors: ["255,0,0,255", "255,0,255,255"],
    observedOpaqueColors: ["255,0,0,255", "255,0,255,255"],
    observedColorCounts: { "255,0,0,255": 2000, "255,0,255,255": 8000 },
    pngSha256: sha("a"),
  }, spec, 35);
}

function nativeMatrix(): NativePaletteRow[] {
  return FONT_PALETTE_CASES.map((spec) => ({ ...nativeRow(), id: spec.id }));
}

function order(first: "base2" | "base3", captured: string): ProductionOrderEvidence {
  const second = first === "base2" ? "base3" : "base2";
  const source = first === "base2" ? [sha("a"), sha("b")] : [sha("b"), sha("a")];
  return {
    order: [first, second], sourcePngSha256: source,
    sourceOpaqueColors: [["red", "magenta"], ["cyan", "green"]],
    capturedPngSha256: [captured, captured], capturedPngCount: 2, capturedUniquePngCount: 1,
    svgImageCount: 2, captureHasFontPaletteFact: false, selectedRepresentation: "colr", warnings: [], svg: "<image/><image/>",
  };
}

describe("DM-2350 font-palette ownership audit", () => {
  it("pins and decodes the source CPAL/COLR identity", () => {
    const facts = readPaletteSourceFacts();
    expect(facts.sha256).toBe(FONT_PALETTE_FIXTURE_SHA256);
    expect(FONT_PALETTE_SOURCE_PINS).toEqual(expect.objectContaining({
      chromium: "7d859f271cbda744098ac69f44978d4edfa62be3",
      skia: "62efacd37737505732dbe3d8daa62abd679626a1",
    }));
    expect(facts).toEqual(expect.objectContaining({
      familyName: "Ahem", postscriptName: "Ahem", glyphId: 35,
      colrVersion: 0, cpalVersion: 1, paletteEntries: 8, paletteCount: 16,
      layerPaletteIndices: [3, 7],
    }));
    expect(facts.paletteTypes.slice(0, 4)).toEqual([0, 0, 1, 2]);
    expect(expectedPaletteColors(facts, FONT_PALETTE_CASES.find((row) => row.id === "named-base2")!))
      .toEqual(["255,0,0,255", "255,0,255,255"]);
    expect(expectedPaletteColors(facts, FONT_PALETTE_CASES.find((row) => row.id === "named-base3")!))
      .toEqual(["0,255,0,255", "0,255,255,255"]);
  });

  it.each(["computed", "source-gid", "custom", "glyph", "colors", "inert", "rule", "rule-family"])("rejects a hostile %s mutation", (kind) => {
    const row = nativeRow();
    const input = { ...row, cssomRule: row.cssomRule == null ? null : { ...row.cssomRule }, observedColorCounts: { ...row.observedColorCounts } };
    if (kind === "computed") input.computedFontPalette = "--base3";
    if (kind === "source-gid") input.sourceGlyphId = 36;
    if (kind === "custom") input.isCustomFont = false;
    if (kind === "glyph") input.paintedGlyphCount = 2;
    if (kind === "colors") input.observedOpaqueColors = ["0,0,0,255"];
    if (kind === "inert") input.observedColorCounts["255,0,0,255"] = 0;
    if (kind === "rule") input.cssomRule!.name = "--other";
    if (kind === "rule-family") input.cssomRule!.fontFamily = "OtherFace";
    expect(adjudicateNativePaletteRow(input, FONT_PALETTE_CASES.find((row) => row.id === "named-base2")!, 35).pass).toBe(false);
  });

  it("accepts only one-level native antialias fringes around exact palette colors", () => {
    const expected = ["255,255,0,255", "255,255,255,255"];
    expect(opaquePaletteColorsWithinTolerance(
      [...expected, "255,255,1,255", "255,255,254,255"], expected,
    )).toBe(true);
    expect(opaquePaletteColorsWithinTolerance(["255,255,1,255", "255,255,255,255"], expected)).toBe(false);
    expect(opaquePaletteColorsWithinTolerance([...expected, "255,255,2,255"], expected)).toBe(false);
  });

  it("classifies order-dependent first-raster reuse as a confirmed gap", () => {
    const rows = nativeMatrix();
    expect(classifyPaletteAudit(rows, [order("base2", sha("a")), order("base3", sha("b"))], [1]))
      .toBe("confirmed-palette-identity-gap");
    const inert = order("base3", sha("a"));
    expect(classifyPaletteAudit(rows, [order("base2", sha("a")), inert], [1])).toBe("inconclusive");
    const bad = nativeRow(); bad.pass = false;
    expect(classifyPaletteAudit([bad], [order("base2", sha("a")), order("base3", sha("b"))], [1])).toBe("invalid-evidence");
  });
});
