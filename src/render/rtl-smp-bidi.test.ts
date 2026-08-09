/**
 * SMP right-to-left scripts must reach the Unicode Bidi Algorithm — AND
 * resolve to an odd (RTL) embedding level once they get there.
 *
 * `bidiLevelsFor` guards `bidi-js`'s `getEmbeddingLevels` behind a cheap regex
 * so the overwhelmingly common all-LTR run costs nothing. That guard covered
 * the BMP only, so every RTL script outside it — Adlam, Kharoshthi, Sogdian,
 * Old Uyghur, Garay, Mende Kikakui, Yezidi, Chorasmian, Elymaic, Hanifi
 * Rohingya, Manichaean, Old Turkic, Old Hungarian, the Pahlavi scripts, the
 * Arabic Mathematical Alphabetic Symbols — was rejected before the algorithm
 * ever ran, and the segmenter then defaulted the run to `rtl: false`.
 *
 * The asymmetry is what makes this worth pinning: the guard is a FAST PATH, not
 * the answer. A false positive costs one extra call that returns all-zero
 * levels; a false negative silently shapes an RTL run left-to-right. So the
 * guard must be conservative, and the fix widened it with two broad ranges
 * rather than a curated per-script list — a hand-listed set is exactly what left
 * it short, and the sibling `RTL_SMP_SCRIPT_RANGES` (which knows these scripts
 * are RTL, and is used for dotted-circle layout) shows the same list drifting
 * out of agreement with itself.
 *
 * The BMP cases are asserted alongside because the widening added the `u` flag
 * to a regex that did not have it, which changes character-class semantics.
 *
 * Reaching the algorithm used to not be enough: `bidi-js` 1.0.3's
 * `getEmbeddingLevels` iterates the string per UTF-16 code unit
 * (`node_modules/bidi-js/src/embeddingLevels.js:58-61`), so an SMP
 * character's surrogate pair was looked up as two lone units, each of which
 * falls back to strong-`L` (`node_modules/bidi-js/src/charTypes.js:47-49`).
 * That is a library bug, not a missing-data one — `_bidi.getBidiCharType`
 * itself reports U+1E900 (Adlam) as `R` and U+10F30 (Sogdian) as `AL`
 * correctly. `bidiLevelsFor` now works around it by substituting two BMP
 * stand-ins of the same Bidi_Class for each SMP surrogate pair before
 * calling `getEmbeddingLevels` (see `withBmpStandIns` in
 * `script-segmentation.ts`), so this suite asserts the CORRECTED (odd/RTL)
 * levels rather than the library's raw wrong answer.
 */
import { describe, expect, it } from "vitest";
import { bidiLevelsFor } from "./script-segmentation.js";

/** `bidiLevelsFor` returns undefined when it decides the text cannot contain a
 *  direction boundary — i.e. when the UBA is skipped entirely. */
const reachesBidi = (cp: number): boolean =>
  bidiLevelsFor(`A${String.fromCodePoint(cp)}B`) !== undefined;

describe("bidiLevelsFor — SMP RTL scripts reach the bidi algorithm", () => {
  it.each([
    ["Adlam", 0x1e900],
    ["Kharoshthi", 0x10a00],
    ["Sogdian", 0x10f30],
    ["Old Uyghur", 0x10f70],
    ["Hanifi Rohingya", 0x10d00],
    ["Old Hungarian", 0x10c80],
    ["Old Turkic", 0x10c00],
    ["Phoenician", 0x10900],
    ["Mende Kikakui", 0x1e800],
    ["Arabic Math Alphabetic", 0x1ee00],
  ])("%s (U+%s) is not skipped", (_name, cp) => {
    expect(reachesBidi(cp)).toBe(true);
  });

  it("still admits the BMP RTL cases (the guard gained the `u` flag)", () => {
    for (const cp of [0x05d0, 0x0627, 0xfb50, 0xfe70, 0x200f]) {
      expect(reachesBidi(cp)).toBe(true);
    }
  });

  it("still skips text with no RTL character — the fast path must stay fast", () => {
    for (const cp of [0x0041, 0x4e2d, 0x0915, 0x1f600, 0x0391]) {
      expect(reachesBidi(cp)).toBe(false);
    }
    expect(bidiLevelsFor("plain ascii text")).toBeUndefined();
  });

  /**
   * FIXED — previously pinned as a KNOWN GAP.
   *
   * `bidi-js` 1.0.3's `getEmbeddingLevels` does not classify SMP RTL
   * characters as strong R/AL by itself, because it looks up char types per
   * UTF-16 code unit rather than per code point (see the module doc comment
   * and `withBmpStandIns` in `script-segmentation.ts`). Measured directly
   * against the raw library, bypassing our wrapper, this is still true:
   *
   *     getEmbeddingLevels("AאB",         "ltr") -> 0,1,0     (BMP Hebrew, correct)
   *     getEmbeddingLevels("A\u{1E900}B", "ltr") -> 0,0,0,0   (Adlam, wrong — raw library)
   *
   * But `bidiLevelsFor` no longer hands text to `getEmbeddingLevels`
   * unmodified — it substitutes same-Bidi_Class BMP stand-ins for each SMP
   * codepoint first, and the corrected embedding level comes back through
   * our wrapper. Two independent SMP RTL scripts (Adlam R, Kharoshthi R) are
   * asserted here so this isn't a one-codepoint coincidence, plus the BMP
   * case to show both paths now agree instead of only the BMP one working.
   *
   * Adlam is cursive-joining, so this is more than an ordering bug: shaping
   * an Adlam run left-to-right (the pre-fix behavior) also selects the wrong
   * contextual letterforms, not just the wrong glyph order — see
   * `docs/font-resolution-diagram.md` and the shaping-invariants section of
   * the project instructions for why direction feeds letterform selection.
   */
  it("resolves SMP RTL characters to an RTL (odd) embedding level", () => {
    // Every SMP codepoint is a surrogate PAIR, i.e. two UTF-16 code units —
    // `bidiLevelsFor` returns one level per code unit, so index 1 is the
    // Adlam character's high surrogate, index 2 its low surrogate, and 'B'
    // has moved to index 3 (unlike the single-code-unit BMP case below).
    const adlam = bidiLevelsFor(`A\u{1E900}B`);
    expect(adlam).toBeDefined();
    expect(Array.from(adlam!)).toEqual([0, 1, 1, 0]);
    expect(adlam![0] % 2).toBe(0); // Latin 'A' — LTR
    expect(adlam![1] % 2).toBe(1); // Adlam, high surrogate — now correctly RTL
    expect(adlam![2] % 2).toBe(1); // Adlam, low surrogate — now correctly RTL
    expect(adlam![3] % 2).toBe(0); // Latin 'B' — LTR

    const kharoshthi = bidiLevelsFor(`A\u{10A00}B`);
    expect(kharoshthi).toBeDefined();
    expect(Array.from(kharoshthi!)).toEqual([0, 1, 1, 0]);
    expect(kharoshthi![0] % 2).toBe(0);
    expect(kharoshthi![1] % 2).toBe(1); // Kharoshthi, high surrogate — RTL
    expect(kharoshthi![2] % 2).toBe(1); // Kharoshthi, low surrogate — RTL
    expect(kharoshthi![3] % 2).toBe(0);

    // The BMP case, to show both paths now agree — Hebrew is a single code
    // unit, so its level lands at index 1 directly.
    expect(bidiLevelsFor("AאB")![1] % 2).toBe(1);
  });
});
