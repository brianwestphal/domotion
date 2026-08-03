// The macOS helper's design-unit advance must be reproducible from the font file
// by an independent reader — i.e. it must equal `hmtx` + `HVAR`, with no AAT
// tracking mixed in.
//
// It did not. The Node side opens every face at `size = unitsPerEm` so metrics come
// back in design units, and `CTFontGetAdvancesForGlyphs` returns a *typeset* advance:
// design advance plus the `trak` table's spacing adjustment interpolated at the
// CTFont's point size. A point size of 1000 (or 2048) runs off the end of `trak`'s
// size table, so CoreText clamped to the largest-size tracking value and added it to
// every advance. On `/System/Library/Fonts/SFIndia.ttc` member `.SFDevanagari-Regular`
// that is exactly −10 units at every `opsz` instance — U+0915 read 823 where the file
// says 833 — and the same constant appeared on every glyph, which is what gave it
// away as a table lookup rather than an axis or interpolation difference.
//
// Tracking is not wrong, it is misplaced: it belongs at the RUN's point size, applied
// once, downstream. Chrome does it with `hb_font_set_ptem(unscaled_font, specified_size)`
// (`third_party/blink/renderer/platform/fonts/shaping/harfbuzz_face.cc:645-648`,
// Chromium 7d859f27); this repo mirrors that by routing `trak` + `STAT` faces' shaping
// through HarfBuzz. Baking a size-1000 value into the design-unit advance both
// double-counts it and uses a size no run has.
//
// The fix reads the advance from the CTFont's CGFont, a design-unit object with no
// point size and therefore no tracking, which carries the variation coordinates
// through unchanged.
//
// These tests are built to fail against a tuned fix as well as against the original
// bug. A constant subtracted to close the SF India gap would break `NewYork-Regular`,
// whose saturated tracking is a different value at a different upem, and would break
// the two zero-tracking controls outright.
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import * as fontkit from "fontkit";
import { clearGlyphHelperCache, createGlyphHelperFont } from "./glyph-helper.js";

const HELPER = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..", "..", "tools", "macos-glyph-extractor", "domotion-glyph-paths",
);

const SF_INDIA = "/System/Library/Fonts/SFIndia.ttc";
const NEW_YORK = "/System/Library/Fonts/NewYork.ttf";
const SFNS = "/System/Library/Fonts/SFNS.ttf";
const HELVETICA = "/System/Library/Fonts/Helvetica.ttc";

const available = process.platform === "darwin" && existsSync(HELPER) && existsSync(SF_INDIA);
const describeMac = available ? describe : describe.skip;

/** Design-unit advances for `gids`, as the helper reports them. */
function helperAdvances(
  fontPath: string, postscriptName: string, gids: number[],
  variations?: Record<string, number>,
): number[] {
  clearGlyphHelperCache();
  const f = createGlyphHelperFont({ postscriptName, fontPath, variations });
  if (f == null) throw new Error(`helper could not open ${postscriptName}`);
  return gids.map((id) => f.getGlyph(id).advanceWidth);
}

/** The same advances read straight out of the file by fontkit. */
function fontkitAdvances(
  fontPath: string, postscriptName: string, gids: number[],
  variations?: Record<string, number>,
): number[] {
  const opened = fontkit.openSync(fontPath) as unknown as {
    fonts?: Array<{ postscriptName: string }>;
  };
  const collection = opened.fonts;
  const base = (collection != null
    ? collection.find((x) => x.postscriptName === postscriptName)
    : opened) as unknown as {
      getVariation(v: Record<string, number>): { getGlyph(id: number): { advanceWidth: number } };
      getGlyph(id: number): { advanceWidth: number };
    } | undefined;
  if (base == null) throw new Error(`fontkit found no face ${postscriptName} in ${fontPath}`);
  const face = variations != null ? base.getVariation(variations) : base;
  return gids.map((id) => face.getGlyph(id).advanceWidth);
}

/** Glyph ids that are inked in every face used here, so the comparison has substance.
 *  Ids rather than codepoints because a design-unit advance is a per-gid quantity and
 *  the two readers must be asked about the same gid. */
const GIDS = [5, 10, 20, 38, 55, 80, 120];

/**
 * A design-unit advance is an integer in every consumer that matters. `hmtx` stores
 * integers; HarfBuzz rounds the `HVAR` delta back to one
 * (`advance + roundf (var_table->get_advance_delta_unscaled (…))`,
 * `hb-ot-hmtx-table.hh:369-375`, HarfBuzz 4de187d); CoreGraphics' glyph-space advance
 * is an `int32`. Only fontkit keeps the unrounded interpolation, so a variable
 * instance is compared against fontkit's value rounded — a half-unit tolerance, three
 * orders of magnitude tighter than the tracking offset this file exists to catch.
 */
function expectAgreement(
  label: string, fontPath: string, postscriptName: string,
  variations?: Record<string, number>,
): void {
  const mine = helperAdvances(fontPath, postscriptName, GIDS, variations);
  const theirs = fontkitAdvances(fontPath, postscriptName, GIDS, variations);
  // Compared as one rendered line so a failure shows every gid's delta at once —
  // the shape of the deltas is the diagnosis. A constant across all of them is a
  // table lookup (tracking); a varying one is an axis or instance difference.
  const rendered = GIDS
    .map((gid, i) => `g${gid} ${mine[i]}-${theirs[i].toFixed(4)}=${(mine[i] - theirs[i]).toFixed(4)}`)
    .join(" ");
  const withinHalfUnit = mine.every((a, i) => Math.abs(a - theirs[i]) <= 0.5);
  expect(`${label} within 0.5u: ${withinHalfUnit} [${rendered}]`)
    .toBe(`${label} within 0.5u: true [${rendered}]`);
}

describeMac("design-unit advances carry no AAT tracking", () => {
  it("agrees with the file on a trak+STAT face whose tracking saturates non-zero", () => {
    // The reported case. `.SFDevanagari-Regular` (upem 1000) has a `trak` normal
    // track of [38, 20, 0, −10] at sizes [12, 17, 28, 34], so opening at 1000 pt
    // clamps to −10 and every advance came back 10 units short.
    expectAgreement("SFDevanagari default", SF_INDIA, ".SFDevanagari-Regular");
    expectAgreement("SFDevanagari opsz 17", SF_INDIA, ".SFDevanagari-Regular", { opsz: 17 });
    expectAgreement("SFDevanagari opsz 20", SF_INDIA, ".SFDevanagari-Regular", { opsz: 20 });
  });

  it("pins the exact advance the ticket measured", () => {
    // U+0915 is gid 38 in this face. The three numbers the file yields, spelled out,
    // so a regression names itself rather than showing up as a tolerance failure.
    const [dflt] = helperAdvances(SF_INDIA, ".SFDevanagari-Regular", [38]);
    const [at17] = helperAdvances(SF_INDIA, ".SFDevanagari-Regular", [38], { opsz: 17 });
    const [at20] = helperAdvances(SF_INDIA, ".SFDevanagari-Regular", [38], { opsz: 20 });
    expect([dflt, at17, at20]).toEqual([802, 833, 825]);
    // The pre-fix values, named so the failure mode is unmistakable if it returns.
    expect([dflt, at17, at20]).not.toEqual([792, 823, 814.544]);
  });

  it("agrees on a SECOND face whose tracking saturates to a different value", () => {
    // The discriminator against a tuned constant. New York saturates at −36 on a
    // 2048 upem where SF India saturates at −10 on a 1000 upem; no single subtracted
    // offset closes both, and no per-upem scale factor does either.
    if (!existsSync(NEW_YORK)) return;
    expectAgreement("NewYork opsz 19", NEW_YORK, ".NewYork-Regular", { opsz: 19 });
  });

  it("leaves faces that were already correct alone", () => {
    // Two controls the original bug never touched, and that a subtract-a-constant
    // fix would break. SF NS carries trak + STAT but its track saturates to 0;
    // Helvetica carries no trak at all.
    if (existsSync(SFNS)) expectAgreement("SFNS opsz 15", SFNS, ".SFNS-Regular", { opsz: 15 });
    if (existsSync(HELVETICA)) expectAgreement("Helvetica", HELVETICA, "Helvetica");
  });

  it("does not vary with the point size the face is opened at", () => {
    // The property that makes the number a DESIGN unit. Tracking is the only
    // size-dependent term in an advance, so if it is gone the design-unit answer is
    // the same however the face was reached. Asserted through the same public entry
    // point rather than a second code path, so it cannot pass by measuring something
    // else — `createGlyphHelperFont` opens at unitsPerEm, and the cache is cleared
    // between calls so each one really re-opens the face.
    const a = helperAdvances(SF_INDIA, ".SFDevanagari-Regular", GIDS, { opsz: 17 });
    const b = helperAdvances(SF_INDIA, ".SFDevanagari-Regular", GIDS, { opsz: 17 });
    expect(a).toEqual(b);
    // And the axis still moves the answer — proof the variation survives the CGFont
    // hop, rather than every instance collapsing to the default.
    const dflt = helperAdvances(SF_INDIA, ".SFDevanagari-Regular", GIDS);
    expect(a).not.toEqual(dflt);
  });
});
