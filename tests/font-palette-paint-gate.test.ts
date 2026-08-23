import { describe, expect, it } from "vitest";

import {
  COLRV1_GIT_BLOB,
  COLRV1_SHA256,
  adjudicateColrv1Row,
  readColrv1SourceFacts,
} from "../tools/font-palette-paint-gate.js";

const baseRow = () => ({
  id: "override" as const, dpr: 1 as const, computedPalette: "--override",
  isCustomFont: true, paintedGlyphCount: 1, opaquePixelCount: 100,
  channelMin: [1, 2, 255] as [number, number, number],
  channelMax: [254, 253, 255] as [number, number, number],
  pngSha256: "a".repeat(64),
});

describe("DM-2510 strict COLRv1 paint gate", () => {
  it("authenticates and decodes the pinned PaintLinearGradient source", () => {
    expect(readColrv1SourceFacts()).toEqual(expect.objectContaining({
      sha256: COLRV1_SHA256, gitBlob: COLRV1_GIT_BLOB,
      familyName: "COLRv1 Static Test Glyphs",
      postscriptName: "COLRv1StaticTestGlyphs-Regular",
      colrVersion: 1, cpalVersion: 1, glyphId: 8, paintFormat: 4,
      paletteIndices: [0, 4], stopOffsets: [0, 1],
    }));
  });

  it.each(["custom", "glyph", "opaque", "outside", "constant", "inert"])("rejects hostile %s evidence", (mutation) => {
    const row = baseRow();
    if (mutation === "custom") row.isCustomFont = false;
    if (mutation === "glyph") row.paintedGlyphCount = 2;
    if (mutation === "opaque") row.opaquePixelCount = 0;
    if (mutation === "outside") row.channelMax[2] = 254;
    if (mutation === "constant") row.channelMin[2] = 254;
    if (mutation === "inert") row.channelMax[0] = row.channelMin[0];
    expect(adjudicateColrv1Row(row, [[255, 0, 255, 255], [0, 255, 255, 255]]).pass).toBe(false);
  });
});
