// AAT tracking (`trak`) is size-dependent, and the size has to be told to it.
//
// HarfBuzz applies the `trak` table when a face carries both `trak` and `STAT`
// (`external/harfbuzz/src/hb-ot-shape.cc:216-220`, rev 4de187d), and it reads
// the amount from the font's `ptem` — its nominal point size. Blink sets that
// on every shaped run, and Chromium's comment says why in as many words
// (`platform/fonts/shaping/harfbuzz_face.cc:641-647`, rev 7d859f27):
//
//     // Setting ptem here is critical for HarfBuzz to know where to lookup
//     // spacing offset in the AAT trak table [...]
//     hb_font_set_ptem(unscaled_font, specified_size > 0 ? specified_size
//                                                        : platform_data_->size());
//
// We were not setting it, so `ptem` stayed 0 and no tracking was applied. That
// is not a neutral default — it is a different answer from Chrome's on every
// macOS face with `trak` + `STAT`, which is Helvetica, Times, SF Pro and all
// eight PingFang cuts.
//
// These tests are macOS-only because they need a real `trak` + `STAT` face and
// synthesising one is not tractable: `trak` is a per-size interpolated table
// and `STAT` has to be well-formed enough for HarfBuzz's sanitizer, so a
// hand-built pair would be testing the builder rather than the shaper.
import { describe, expect, it, beforeEach } from "vitest";
import { existsSync } from "node:fs";
import { _clearHbFontCache, harfbuzzShapeRun } from "./harfbuzz-shaper.js";

/** PingFang UI — carries `trak`, `STAT`, `GSUB`, and no `morx`. */
const PINGFANG = "/System/Library/PrivateFrameworks/FontServices.framework/Resources/Reserved/PingFangUI.ttc";
/** SF NS — a variable file with a `wght` axis. */
const SFNS = "/System/Library/Fonts/SFNS.ttf";
const onMac = process.platform === "darwin" && existsSync(PINGFANG);
const macOnly = onMac ? it : it.skip;

/** First advance of "fi fl ffi", in font units. */
function firstAdvance(sizePx: number | undefined): number {
  const r = harfbuzzShapeRun(PINGFANG, 0, "fi fl ffi", undefined, sizePx);
  expect(r).not.toBeNull();
  return r!.positions[0].xAdvance;
}

beforeEach(() => {
  _clearHbFontCache();
});

describe("AAT tracking follows the run's size", () => {
  macOnly("tracks tighter as the size grows, and not at all without one", () => {
    // The numbers are the assertion. A test that only checked "the size argument
    // is accepted" would have passed throughout the defect, since the old code
    // shaped perfectly well — it just shaped every run as if it were 0 pt.
    //
    // 398 is the untracked advance. 381 is what the CoreText helper produces,
    // because it opens the face at size = unitsPerEm (1000) — which is how this
    // was found: the two engines agreed exactly once given the same ptem, so
    // the disagreement was never about the engines.
    expect(firstAdvance(undefined)).toBe(398);
    expect(firstAdvance(16)).toBe(397);
    expect(firstAdvance(32)).toBe(386);
    expect(firstAdvance(1000)).toBe(381);
  });

  macOnly("does not leak a previous run's size through the shared font cache", () => {
    // The font object is cached per (file, face index) and reused across runs of
    // every size, so `ptem` is mutable state crossing a cache boundary. Setting
    // it only when a size is passed would leave the previous run's tracking in
    // place — a 16 px run after a 32 px one would silently track at 32.
    //
    // Both directions, and a return to the start: a single A→B sequence passes
    // even when the value is simply never reset.
    expect(firstAdvance(16)).toBe(397);
    expect(firstAdvance(1000)).toBe(381);
    expect(firstAdvance(16)).toBe(397);
    expect(firstAdvance(undefined)).toBe(398);
    expect(firstAdvance(32)).toBe(386);
    expect(firstAdvance(undefined)).toBe(398);
  });

  macOnly("treats a zero or negative size as no tracking, not as 0 pt tracking", () => {
    // Mirrors Blink's `specified_size > 0 ? specified_size : …` guard. A size of
    // 0 reaching HarfBuzz as a real ptem would be indistinguishable from unset
    // here, but the guard is what stops a negative or NaN size from becoming an
    // arbitrary tracking lookup.
    expect(firstAdvance(0)).toBe(398);
    expect(firstAdvance(-5)).toBe(398);
  });
});

describe("variable faces shape at the run's axis location", () => {
  // Blink does not hand HarfBuzz an unvaried face: it clones the typeface at the
  // resolved coordinates first (`mac/font_platform_data_mac.mm:169-185`, rev
  // 7d859f27), and Skia applies and re-clamps them
  // (`ctvariation_from_SkFontArguments`, `SkTypeface_mac_ct.cpp:1147`). We did
  // not, so every variable file shaped at its DEFAULT fvar instance whatever
  // weight the run resolved to.
  const varOnly = process.platform === "darwin" && existsSync(SFNS) ? it : it.skip;

  /** First four advances of a pangram fragment, at an axis location. */
  function advances(axes: Record<string, number> | null): string {
    const r = harfbuzzShapeRun(SFNS, 0, "Hamburgefonstiv", undefined, 16, axes);
    expect(r).not.toBeNull();
    return r!.positions.slice(0, 4).map((p) => p.xAdvance).join(" ");
  }

  varOnly("shapes two weights differently, and neither as the default", () => {
    // Three distinct values is the assertion. Comparing ONE location against the
    // default cannot distinguish "applied" from "the default happens to be that
    // weight" — SF NS defaults to wght 400, so a 400-only test passes whether or
    // not the location is applied at all.
    const dflt = advances(null);
    const light = advances({ wght: 300 });
    const bold = advances({ wght: 700 });
    expect(light).not.toBe(dflt);
    expect(bold).not.toBe(dflt);
    expect(light).not.toBe(bold);
  });

  varOnly("does not leak a previous run's axis location through the font cache", () => {
    // Same hazard as ptem above: the font is cached per (file, face index), so a
    // location applied for one run persists into the next unless it is reset.
    // The null arm is the one that catches it — a static face, or a caller with
    // no location, must see the DEFAULT master and not the last variable run's.
    const dflt = advances(null);
    const bold = advances({ wght: 700 });
    expect(advances(null)).toBe(dflt);
    expect(advances({ wght: 700 })).toBe(bold);
    expect(advances({ wght: 300 })).not.toBe(bold);
    expect(advances(null)).toBe(dflt);
  });
});
