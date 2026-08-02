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
