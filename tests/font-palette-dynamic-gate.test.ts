import { describe, expect, it } from "vitest";

import {
  FONT_PALETTE_DYNAMIC_SOURCE_PINS,
  adjudicateDynamicProductionOrder,
  adjudicateDynamicV0Row,
  adjudicateDynamicV1Row,
  type DynamicProductionOrderEvidence,
} from "../tools/font-palette-dynamic-gate.js";

const hash = (value: string): string => value.repeat(64);

describe("dynamic font-palette logical gate", () => {
  it("pins Blink's animation, recursive mix, paint, and shadow-scope decisions", () => {
    expect(FONT_PALETTE_DYNAMIC_SOURCE_PINS).toEqual(expect.objectContaining({
      chromium: "7d859f271cbda744098ac69f44978d4edfa62be3",
      skia: "62efacd37737505732dbe3d8daa62abd679626a1",
    }));
    expect(FONT_PALETTE_DYNAMIC_SOURCE_PINS.animation).toContain("interpolable_font_palette.cc");
    expect(FONT_PALETTE_DYNAMIC_SOURCE_PINS.mixNormalization).toContain("css_color_mix_value.cc");
    expect(FONT_PALETTE_DYNAMIC_SOURCE_PINS.selectorResolution).toContain("css_font_selector.cc");
    expect(FONT_PALETTE_DYNAMIC_SOURCE_PINS.skiaArguments).toContain("SkFontArguments.h");
    expect(FONT_PALETTE_DYNAMIC_SOURCE_PINS.shadowScope).toContain("style_engine.cc");
  });

  it.each(["computed", "colors"])("rejects hostile COLRv0 %s evidence", (mutation) => {
    const row = {
      id: "mix-srgb-30" as const,
      dpr: 1 as const,
      computedPalette: "palette-mix(in srgb, --base3 70%, --base7)",
      expectedComputedPalette: "palette-mix(in srgb, --base3 70%, --base7)",
      expectedOpaqueColors: ["0,255,179,255", "0,255,77,255"].sort(),
      observedOpaqueColors: ["0,255,179,255", "0,255,77,255"].sort(),
      pngSha256: hash("a"),
    };
    if (mutation === "computed") row.computedPalette = "normal";
    if (mutation === "colors") row.observedOpaqueColors = ["0,0,0,255"];
    expect(adjudicateDynamicV0Row(row).pass).toBe(false);
  });

  it.each(["computed", "opaque", "outside", "constant", "inert"])("rejects hostile COLRv1 %s evidence", (mutation) => {
    const row = {
      id: "mix-srgb-50" as const,
      dpr: 1 as const,
      computedPalette: "palette-mix(in srgb, normal, --base1)",
      expectedComputedPalette: "palette-mix(in srgb, normal, --base1)",
      expectedEndpoints: [[255, 0, 255, 255], [0, 255, 255, 255]] as [[number, number, number, number], [number, number, number, number]],
      opaquePixelCount: 100,
      channelMin: [1, 2, 255] as [number, number, number],
      channelMax: [254, 253, 255] as [number, number, number],
      pngSha256: hash("a"),
    };
    if (mutation === "computed") row.computedPalette = "normal";
    if (mutation === "opaque") row.opaquePixelCount = 0;
    if (mutation === "outside") row.channelMax[2] = 254;
    if (mutation === "constant") row.channelMin[2] = 254;
    if (mutation === "inert") row.channelMax[0] = row.channelMin[0];
    expect(adjudicateDynamicV1Row(row).pass).toBe(false);
  });

  it.each(["source", "capture", "content", "image", "representation", "identity-count", "identity", "warnings"])("rejects hostile production %s evidence", (mutation) => {
    const base: Omit<DynamicProductionOrderEvidence, "pass" | "blockers"> = {
      dpr: 1,
      order: ["mix-srgb-30", "animation-oklab-30"],
      sourcePngSha256: [hash("a"), hash("b")],
      capturedPngSha256: [hash("a"), hash("b")],
      capturedPngCount: 2,
      capturedUniquePngCount: 2,
      svgImageCount: 2,
      selectedRepresentation: "colr",
      capturedPaletteRecords: [{}, {}],
      identityChecks: { mix: true, time: true },
      warnings: [],
    };
    if (mutation === "source") base.sourcePngSha256.pop();
    if (mutation === "capture") base.capturedPngCount = 1;
    if (mutation === "content") base.capturedPngSha256[1] = hash("c");
    if (mutation === "image") base.svgImageCount = 1;
    if (mutation === "representation") base.selectedRepresentation = "outline";
    if (mutation === "identity-count") base.capturedPaletteRecords.pop();
    if (mutation === "identity") base.identityChecks.time = false;
    if (mutation === "warnings") base.warnings.push("font-palette:approximate");
    expect(adjudicateDynamicProductionOrder(base).pass).toBe(false);
  });
});
