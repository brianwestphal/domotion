// The per-codepoint fallback's cascade BASE is the run's resolved cut.
//
// Blink asks CoreText for a substitute from `font_data_to_substitute->
// PlatformData()` — the face the run is actually painting in
// (`mac/font_cache_mac.mm:326-327` → `GetAlternateFontPlatformData` →
// `CTFontCreateForString(ct_font, …)`, Chromium rev 7d859f27). We asked from the
// family's BASE entry instead, and CoreText's cascade is a function of the font
// you ask from: asked from Times-Roman it nominates STSongti-SC-Regular, asked
// from Times-Bold it nominates STSongti-SC-Bold.
//
// That difference is not recoverable downstream. The in-family re-selection that
// follows (`:242-267`) only adopts a better-matching face when that face still
// covers the character, so for every ideograph Songti SC Black does not carry —
// most of CJK Extension A — a weight-800 serif run kept the REGULAR face
// nominated from the unweighted base where Chrome keeps the BOLD one.
//
// The expectations are Chrome-on-macOS's own, read over CDP with
// `CSS.getPlatformFontsForNode` (by `postScriptName`, largest `glyphCount`).
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { __resolveSystemFallbackKeyForCpForTest } from "./font-resolution.js";
import { isGlyphHelperAvailable } from "./glyph-helper.js";

const available = process.platform === "darwin"
  && existsSync("/System/Library/Fonts/Supplemental/Songti.ttc")
  && isGlyphHelperAvailable();
const describeMac = available ? describe : describe.skip;

/** U+4E00 一 — carried by every Songti SC cut, INCLUDING Black. */
const HAN_IN_BLACK = 0x4E00;
/** U+340F 㐏 — CJK Extension A, carried by Songti SC but NOT by its Black cut. */
const HAN_NOT_IN_BLACK = 0x340F;

const fallback = (cp: number, weight: number): string | null =>
  __resolveSystemFallbackKeyForCpForTest(cp, weight, 0, 16, "times");

describeMac("system-fallback cascade base", () => {
  it("walks the cascade from the cut the run paints in, not the family's base entry", () => {
    // The whole ladder, because the bug lived only at its top: at 400 and 700
    // the base entry and the resolved cut happen to nominate the same face, so
    // a test sampling those two would pass with the defect in place.
    expect(fallback(HAN_NOT_IN_BLACK, 400)).toBe("sysfb:STSongti-SC-Regular");
    expect(fallback(HAN_NOT_IN_BLACK, 700)).toBe("sysfb:STSongti-SC-Bold");
    expect(fallback(HAN_NOT_IN_BLACK, 800)).toBe("sysfb:STSongti-SC-Bold");
    expect(fallback(HAN_NOT_IN_BLACK, 900)).toBe("sysfb:STSongti-SC-Bold");
  });

  it("still re-selects in-family when the better-matching cut covers the character", () => {
    // The base fix must not swallow the re-selection stage. U+4E00 IS in Songti
    // SC Black, so the coverage guard passes and weight 800/900 lands on Black —
    // which is what Chrome paints for that codepoint on its own.
    expect(fallback(HAN_IN_BLACK, 400)).toBe("sysfb:STSongti-SC-Regular");
    expect(fallback(HAN_IN_BLACK, 700)).toBe("sysfb:STSongti-SC-Bold");
    expect(fallback(HAN_IN_BLACK, 800)).toBe("sysfb:STSongti-SC-Black");
    expect(fallback(HAN_IN_BLACK, 900)).toBe("sysfb:STSongti-SC-Black");
  });

  it("keeps the two codepoints' answers independent across an interleaved walk", () => {
    // The base is memoized per (key, weight, slant, width) and the fallback
    // answer per (codepoint, …, base). Either memo missing a field would let one
    // codepoint's answer leak into the other's — the failure mode that made an
    // earlier under-keyed helper cache serve whichever caller asked first.
    const seq: Array<[number, number]> = [
      [HAN_IN_BLACK, 800], [HAN_NOT_IN_BLACK, 800], [HAN_IN_BLACK, 400],
      [HAN_NOT_IN_BLACK, 900], [HAN_IN_BLACK, 800], [HAN_NOT_IN_BLACK, 400],
    ];
    expect(seq.map(([cp, w]) => fallback(cp, w))).toEqual([
      "sysfb:STSongti-SC-Black", "sysfb:STSongti-SC-Bold", "sysfb:STSongti-SC-Regular",
      "sysfb:STSongti-SC-Bold", "sysfb:STSongti-SC-Black", "sysfb:STSongti-SC-Regular",
    ]);
  });
});
