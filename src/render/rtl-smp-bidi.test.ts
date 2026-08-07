/**
 * SMP right-to-left scripts must reach the Unicode Bidi Algorithm.
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
   * KNOWN GAP, pinned deliberately rather than asserted as correct.
   *
   * Reaching the UBA is necessary but NOT sufficient: bidi-js 1.0.3 does not
   * classify SMP RTL characters as strong R, so it returns an all-LTR answer.
   * Measured directly against the library, bypassing our wrapper:
   *
   *     getEmbeddingLevels("AאB",       "ltr") -> 0,1,0     (BMP Hebrew, correct)
   *     getEmbeddingLevels("A\u{1E900}B", "ltr") -> 0,0,0,0   (Adlam, wrong)
   *
   * So the guard widening above is a prerequisite, not the fix — and it is a
   * no-op today, since all-zero levels segment identically to `undefined`
   * (verified across several SMP RTL strings). It is still worth having: with
   * the guard closed, a corrected bidi-js would change nothing, and the defect
   * would look like a library bug rather than ours.
   *
   * This test asserts the CURRENT behaviour so the day it starts failing is the
   * day SMP RTL begins working — at which point flip it to expect odd levels
   * and check what the segmenter does with them.
   */
  it("does NOT yet resolve an SMP RTL character to an RTL level (bidi-js gap)", () => {
    const levels = bidiLevelsFor(`A\u{1E900}B`);
    expect(levels).toBeDefined();
    expect(levels![0] % 2).toBe(0); // Latin 'A' — LTR, correct
    expect(levels![1] % 2).toBe(0); // Adlam — SHOULD be 1; bidi-js says 0
    // The BMP equivalent, to show the difference is the library's and not ours.
    expect(bidiLevelsFor("AאB")![1] % 2).toBe(1);
  });
});
