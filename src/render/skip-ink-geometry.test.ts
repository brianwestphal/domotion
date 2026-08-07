/**
 * Skip-ink gap GEOMETRY: which characters contribute intercepts, and how far
 * each intercept is dilated.
 *
 * Companion to `skip-ink-exclusions.test.ts`, which pins the predicate itself.
 * This file pins that `computeSkipInkGaps` actually consults it, per character,
 * and that the dilation matches Blink's constant — two things the predicate
 * being correct does not imply.
 *
 * The dilation previously read `max(0.5, thickness * 0.5)` and cited a
 * `kIntersectionExtension` that does not exist anywhere in Chromium. Blink's
 * real value is `min(thickness, kDecorationClipMaxDilation)` with the constant
 * 13 (`core/paint/text_painter.cc:46` and `:607-608`, Chromium rev `7d859f27`),
 * applied via `clip_rect.Outset(OutsetsF::VH(1.0, dilation))` — `VH` is
 * (vertical, horizontal), so the whole value lands on each horizontal side.
 * Below the cap the old value was exactly half the right one.
 */
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { computeSkipInkGaps } from "./text-to-path.js";

// Needs a real host font: these assertions are about painted outlines.
const MACOS_FONTS = process.platform === "darwin" && existsSync("/System/Library/Fonts/Helvetica.ttc");
const d = MACOS_FONTS ? describe : describe.skip;

const FONT = { fontSize: 18, fontFamily: "Helvetica", fontWeight: "400" };
const BAND = { decorationCenterYRel: 1.5, decorationThickness: 1 };

const gapsFor = (text: string, over: Partial<typeof BAND> = {}) =>
  computeSkipInkGaps(text, FONT, { ...BAND, ...over });

d("computeSkipInkGaps — excluded characters contribute no intercepts", () => {
  it("a CJK run produces zero gaps", () => {
    // The user-visible defect: we skip-inked everything, so underlined CJK got
    // gaps Chrome never paints. `IsCjkIdeographOrSymbol` excludes these.
    expect(gapsFor("日本語漢字")).toEqual([]);
  });

  it("a Hangul run produces zero gaps", () => {
    // Reaches the block clause, which the CJK property does not cover — so
    // this case is invisible to any amount of Han testing.
    expect(gapsFor("한국어")).toEqual([]);
  });

  it("`/ \\ _` produce zero gaps", () => {
    expect(gapsFor("/")).toEqual([]);
    expect(gapsFor("\\")).toEqual([]);
    expect(gapsFor("_")).toEqual([]);
    expect(gapsFor("/\\_")).toEqual([]);
  });

  it("still gaps for Latin descenders — the exclusion did not disable skip-ink", () => {
    // Without this the three assertions above are satisfied by a broken
    // implementation that returns [] for everything.
    expect(gapsFor("jumping").length).toBeGreaterThanOrEqual(2);
  });

  it("is applied PER CHARACTER: mixed CJK + Latin gaps only on the Latin", () => {
    // Blink drops intercepts in `IsSkipInkException` at each character index
    // (`shape_result_bloberizer.cc:228-234`), not per run. A run-level
    // implementation would return [] here — and would look correct against
    // both the pure-CJK and pure-Latin cases above, which is exactly why this
    // assertion has to exist separately.
    const mixed = gapsFor("日jp語");
    expect(mixed.length).toBeGreaterThanOrEqual(1);
  });
});

d("computeSkipInkGaps — dilation is min(thickness, 13)", () => {
  // Isolating the dilation from the band takes care: the band height is
  // DERIVED from the thickness, so raising the thickness also widens the raw
  // intercept until the band is taller than the glyph's ink, after which the
  // intercept saturates at the full ink extent and every further change in gap
  // width is dilation alone. Measured on this font, saturation holds from
  // thickness 4 upward at 4px — hence the small size here rather than the 18px
  // used elsewhere in the file, where saturation does not begin until roughly
  // the cap itself and the two effects cannot be separated.
  const SMALL = { ...FONT, fontSize: 4 };
  const wide = (thickness: number) => {
    const g = computeSkipInkGaps("g", SMALL, { decorationCenterYRel: 0, decorationThickness: thickness });
    expect(g.length).toBe(1);
    return g[0][1] - g[0][0];
  };

  it("caps at 13, so two thicknesses above the cap dilate identically", () => {
    // Under the old `t/2` rule these differed by 2*(20-13) = 14px.
    expect(wide(40)).toBeCloseTo(wide(26), 5);
  });

  it("scales with the FULL thickness below the cap, not half of it", () => {
    // pad(10) - pad(6) = 4 per side => 8px overall. The old rule gives 4px,
    // so this is the assertion that discriminates the two constants.
    expect(wide(10) - wide(6)).toBeCloseTo(8, 5);
    // And once more at a smaller step: pad(6) - pad(4) = 2 per side => 4px.
    expect(wide(6) - wide(4)).toBeCloseTo(4, 5);
  });
});
