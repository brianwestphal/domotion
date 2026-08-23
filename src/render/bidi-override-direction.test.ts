import { describe, expect, it } from "vitest";
import { bidiLevelsFor, segmentForShaping, needsSegmentation } from "./script-segmentation.js";

/**
 * CSS `unicode-bidi: bidi-override` is the one bidi input that cannot be
 * recovered from the text, because it is an instruction to stop reading the
 * text's own bidi types. Blink does not special-case it downstream — it appends
 * real Unicode formatting characters and lets the ordinary algorithm run
 * (`core/layout/inline/inline_items_builder.cc:1501-1505`, rev 7d859f27):
 *
 *     case UnicodeBidi::kBidiOverride:
 *     case UnicodeBidi::kIsolateOverride:
 *       EnterBidiContext(nullptr, style, uchar::kLeftToRightOverride,
 *                        uchar::kRightToLeftOverride,
 *                        uchar::kPopDirectionalFormatting);
 *
 * These assert the LEVELS and the resulting segment direction, not pixels. The
 * defect this guards moved `02-deep-bidi-isolate` by 0.0035 percentage points
 * while rendering Hebrew letters backwards — a diff threshold cannot see it, and
 * the region detector only caught it because two words happened not to overlap
 * cleanly. Direction is the thing to assert, so direction is what is asserted.
 */
const HEB = "שלום";          // שלום
const LAT = "hello";
const OVERRIDE_LTR = { direction: "ltr" as const, unicodeBidi: "bidi-override" };
const OVERRIDE_RTL = { direction: "rtl" as const, unicodeBidi: "bidi-override" };

const dirOf = (text: string, ov?: { direction: "ltr" | "rtl"; unicodeBidi: string }) => {
  const levels = bidiLevelsFor(text, ov);
  const segs = needsSegmentation(text, levels)
    ? segmentForShaping(text, levels)
    : [{ start: 0, end: text.length, script: "", rtl: levels != null && levels.length > 0 && (levels[0] & 1) === 1 }];
  return segs.map((s) => (s.rtl ? "rtl" : "ltr"));
};

describe("unicode-bidi: bidi-override forces the embedding direction", () => {
  it("leaves Hebrew right-to-left with no override", () => {
    expect(bidiLevelsFor(HEB)![0] & 1).toBe(1);
    expect(dirOf(HEB)).toEqual(["rtl"]);
  });

  // The defect: Chrome lays these out logical-left-to-right (measured — its
  // per-character x ASCENDS with logical index under the override, and descends
  // without it), while the unmodified algorithm reports level 1 and the shaper
  // reverses the run.
  it("forces Hebrew to Blink's exact even override level under direction: ltr", () => {
    const levels = bidiLevelsFor(HEB, OVERRIDE_LTR)!;
    expect(levels.length).toBe(HEB.length);
    expect([...levels]).toEqual([2, 2, 2, 2]);
    expect(dirOf(HEB, OVERRIDE_LTR)).toEqual(["ltr"]);
  });

  it("forces LATIN to an odd level under bidi-override + direction: rtl", () => {
    const levels = bidiLevelsFor(LAT, OVERRIDE_RTL)!;
    expect(levels.length).toBe(LAT.length);
    expect([...levels]).toEqual([3, 3, 3, 3, 3]);
    expect(dirOf(LAT, OVERRIDE_RTL)).toEqual(["rtl"]);
  });

  it("leaves Hebrew right-to-left under bidi-override + direction: rtl", () => {
    expect([...bidiLevelsFor(HEB, OVERRIDE_RTL)!]).toEqual([3, 3, 3, 3]);
    expect(dirOf(HEB, OVERRIDE_RTL)).toEqual(["rtl"]);
  });

  it("treats isolate-override the same as bidi-override, as Blink's case-fallthrough does", () => {
    const a = bidiLevelsFor(HEB, OVERRIDE_LTR)!;
    const b = bidiLevelsFor(HEB, { direction: "ltr", unicodeBidi: "isolate-override" })!;
    expect([...b]).toEqual([...a]);
  });

  // `normal` / `embed` / `isolate` inject nothing in Blink — they are the
  // algorithm's default behaviour, carried as the paragraph level instead. So
  // they must not change the answer here.
  it("does not disturb the non-override values", () => {
    const plain = [...bidiLevelsFor(HEB)!];
    for (const ub of ["normal", "embed", "isolate", "plaintext"]) {
      expect([...bidiLevelsFor(HEB, { direction: "ltr", unicodeBidi: ub })!], ub).toEqual(plain);
    }
  });

  /**
   * The override is applied by INJECTING the controls and running the real
   * algorithm, not by filling the level array. The difference shows on mixed
   * content: under an RTL override, embedded Latin must still come back at an
   * odd level (the override makes it strong-RTL) — but the levels are resolved,
   * not stamped, so this stays correct for cases a `fill()` would flatten
   * wrongly, and the returned array is still exactly one level per source
   * character so callers' indexing into the text holds.
   */
  it("returns one level per source character, with the injected controls stripped", () => {
    const mixed = HEB + LAT;
    const levels = bidiLevelsFor(mixed, OVERRIDE_RTL)!;
    expect(levels.length).toBe(mixed.length);
    expect([...levels].every((l) => (l & 1) === 1)).toBe(true);
  });

  it("returns undefined for empty text, and for LTR text with no override", () => {
    expect(bidiLevelsFor("")).toBeUndefined();
    expect(bidiLevelsFor(LAT)).toBeUndefined();
  });
});
