// DM-1716/DM-1721: the axis location pinned into hinted embedded subsets for
// native-helper (CoreText/DirectWrite) instances of variable font files —
// including the DM-1721 merge of DirectWrite's RESOLVED axis values (named
// optical subfamilies pin opsz at a fixed value at every font size, so the
// CSS-derived opsz=fontSize pin is wrong for them).
import { describe, expect, it } from "vitest";

import { resolveAxisLocationForFile } from "./font-resolution.js";

/** Segoe UI Variable's fvar shape (wght 300-700, opsz 8-36). */
const SEGOE_AXES = {
  wght: { name: "Weight", min: 300, default: 400, max: 700 },
  opsz: { name: "Optical size", min: 8, default: 10.5, max: 36 },
};

describe("resolveAxisLocationForFile: CSS-derived pins (DM-1716)", () => {
  it("pins wght from CSS weight and opsz from font size", () => {
    expect(resolveAxisLocationForFile(SEGOE_AXES, 700, 24, 0)).toEqual({ wght: 700, opsz: 24 });
  });

  it("clamps to the fvar range", () => {
    // 12px < opsz min 8? no — 12 in range; 40px > max 36 clamps; wght 100 < min 300 clamps.
    expect(resolveAxisLocationForFile(SEGOE_AXES, 100, 40, 0)).toEqual({ wght: 300, opsz: 36 });
  });

  it("ignores axes the file doesn't expose", () => {
    expect(resolveAxisLocationForFile({ wght: { min: 100, max: 900 } }, 400, 16, -12)).toEqual({ wght: 400 });
  });

  it("author font-variation-settings override on top", () => {
    expect(resolveAxisLocationForFile(SEGOE_AXES, 400, 16, 0, { opsz: 36 })).toEqual({ wght: 400, opsz: 36 });
  });
});

describe("resolveAxisLocationForFile: DirectWrite resolved axes (DM-1721)", () => {
  it("resolved opsz replaces the fontSize-derived pin at every size", () => {
    // "Segoe UI Variable Text" is pinned at opsz 10.5 regardless of font size.
    const resolved = { wght: 400, opsz: 10.5 };
    for (const size of [8, 13, 16, 24, 32]) {
      expect(resolveAxisLocationForFile(SEGOE_AXES, 400, size, 0, undefined, resolved))
        .toEqual({ wght: 400, opsz: 10.5 });
    }
  });

  it("resolved wght applies for weight-400 runs (the weight the fallback query maps at)", () => {
    // Bare "Segoe UI Variable" resolves through DirectWrite's own instance
    // mapping (e.g. wght 325); trust it for the 400 request it was mapped for.
    const resolved = { wght: 325, opsz: 36 };
    expect(resolveAxisLocationForFile(SEGOE_AXES, 400, 16, 0, undefined, resolved))
      .toEqual({ wght: 325, opsz: 36 });
  });

  it("CSS weight wins over resolved wght for non-400 runs", () => {
    // The fallback query maps at weight 400 only; a bold run re-derives wght
    // from CSS (DirectWrite re-matches weight per run).
    const resolved = { wght: 400, opsz: 10.5 };
    expect(resolveAxisLocationForFile(SEGOE_AXES, 700, 16, 0, undefined, resolved))
      .toEqual({ wght: 700, opsz: 10.5 });
  });

  it("resolved slnt is ignored (CSS italic drives slant per run)", () => {
    const axes = { ...SEGOE_AXES, slnt: { min: -12, default: 0, max: 0 } };
    expect(resolveAxisLocationForFile(axes, 400, 16, -12, undefined, { slnt: 0, opsz: 10.5 }))
      .toEqual({ wght: 400, opsz: 10.5, slnt: -12 });
  });

  it("resolved tags absent from the file's fvar are dropped", () => {
    expect(resolveAxisLocationForFile(SEGOE_AXES, 400, 16, 0, undefined, { wdth: 100, opsz: 10.5 }))
      .toEqual({ wght: 400, opsz: 10.5 });
  });

  it("resolved values are still clamped to the fvar range", () => {
    expect(resolveAxisLocationForFile(SEGOE_AXES, 400, 16, 0, undefined, { opsz: 72 }))
      .toEqual({ wght: 400, opsz: 36 });
  });

  it("author font-variation-settings override resolved axes (CSS cascade order)", () => {
    expect(resolveAxisLocationForFile(SEGOE_AXES, 400, 16, 0, { opsz: 20 }, { opsz: 10.5 }))
      .toEqual({ wght: 400, opsz: 20 });
  });

  it("no resolved axes → unchanged CSS-derived behavior (macOS/Linux path)", () => {
    expect(resolveAxisLocationForFile(SEGOE_AXES, 400, 16, 0, undefined, undefined))
      .toEqual({ wght: 400, opsz: 16 });
  });
});
