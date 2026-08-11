/**
 * DM-2019: `RTL_SMP_SCRIPT_RANGES` (behind `isRtlScriptCodepoint`) must be a
 * straight port of HarfBuzz's `hb_script_get_horizontal_direction`
 * (`hb-common.cc:522-613`, checked out at `external/harfbuzz`, rev 4de187d),
 * not a hand-curated approximation of it. These tests pin the table against
 * an independently transcribed script list rather than merely re-testing the
 * table's own boundaries, so a future hand-edit that drifts from HarfBuzz's
 * actual rule is caught.
 */
import { describe, it, expect } from "vitest";
import { harfbuzzCanonicalDecompositionCandidates, isHarfbuzzSameFontSpaceFallback, isRtlScriptCodepoint } from "./unicode-classification.js";

// Transcribed directly from `hb_script_get_horizontal_direction`'s switch
// statement (`hb-common.cc:522-613`, rev 4de187d) — the FULL `HB_DIRECTION_RTL`
// case list, independent of `RTL_SMP_SCRIPT_RANGES` itself. Unicode script
// property value names (ECMAScript `\p{Script=...}` aliases).
const HB_RTL_SCRIPTS = [
  "Arabic", "Hebrew", "Syriac", "Thaana", "Cypriot", "Kharoshthi", "Phoenician",
  "Nko", "Lydian", "Avestan", "Imperial_Aramaic", "Inscriptional_Pahlavi",
  "Inscriptional_Parthian", "Old_South_Arabian", "Old_Turkic", "Samaritan",
  "Mandaic", "Meroitic_Cursive", "Meroitic_Hieroglyphs", "Manichaean",
  "Mende_Kikakui", "Nabataean", "Old_North_Arabian", "Palmyrene",
  "Psalter_Pahlavi", "Hatran", "Adlam", "Hanifi_Rohingya", "Old_Sogdian",
  "Sogdian", "Elymaic", "Chorasmian", "Yezidi", "Old_Uyghur", "Garay",
];

// Grouped separately under `HB_DIRECTION_INVALID` ("can be written either
// direction") in the SAME switch statement — genuinely NOT RTL, despite
// looking like they belong on the list above by era/company. Old Hungarian
// in particular: DM-2019 first drafted it as a missing entry by pattern-
// matching the era of the other additions, and HarfBuzz's own source
// disagrees.
const HB_INVALID_DIRECTION_SCRIPTS = ["Old_Hungarian", "Old_Italic", "Runic", "Tifinagh"];

/** Every Script value whose codepoints live entirely or partly in the SMP. */
function smpRangesFor(scriptName: string): Array<[number, number]> {
  let re: RegExp;
  try {
    re = new RegExp(`\\p{Script=${scriptName}}`, "u");
  } catch {
    return []; // Not a recognized alias in this Node's ICU/Unicode version.
  }
  const ranges: Array<[number, number]> = [];
  let start: number | null = null;
  let prev = 0;
  for (let cp = 0x10000; cp <= 0x10ffff; cp++) {
    const hit = re.test(String.fromCodePoint(cp));
    if (hit) {
      if (start === null) start = cp;
      prev = cp;
    } else if (start !== null) {
      ranges.push([start, prev]);
      start = null;
    }
  }
  if (start !== null) ranges.push([start, prev]);
  return ranges;
}

describe("isRtlScriptCodepoint / RTL_SMP_SCRIPT_RANGES (DM-2019)", () => {
  it("table-equality: agrees with hb_script_get_horizontal_direction's RTL scripts across every ASSIGNED SMP codepoint", () => {
    // Build the expected answer independently (live Unicode Script property,
    // NOT the table under test), spanning the entire SMP so this is a real
    // sweep rather than a handful of spot checks.
    //
    // Scoped to ASSIGNED codepoints deliberately: `RTL_SMP_SCRIPT_RANGES`
    // rows are Unicode BLOCK envelopes (matching this table's pre-existing
    // style — see e.g. Kharoshthi/Manichaean above), which harmlessly
    // over-include the small unassigned gaps within a block. Comparing those
    // gaps would fail on rows that predate this ticket too, and they can
    // never be produced by a real render (the sole caller only ever passes
    // an assigned mark codepoint from captured text).
    const assignedRe = /\p{Assigned}/u;
    const expectedRtl = new Uint8Array(0x100000); // indices 0..0xFFFFF map to cp 0x10000..0x10FFFF
    for (const name of HB_RTL_SCRIPTS) {
      for (const [lo, hi] of smpRangesFor(name)) {
        for (let cp = lo; cp <= hi; cp++) expectedRtl[cp - 0x10000] = 1;
      }
    }

    const mismatches: string[] = [];
    for (let cp = 0x10000; cp <= 0x10ffff; cp++) {
      if (!assignedRe.test(String.fromCodePoint(cp))) continue;
      const expected = expectedRtl[cp - 0x10000] === 1;
      const actual = isRtlScriptCodepoint(cp);
      if (expected !== actual && mismatches.length < 20) {
        mismatches.push(`U+${cp.toString(16).toUpperCase()}: expected ${expected}, got ${actual}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("does NOT mark Old Hungarian (or the other HB_DIRECTION_INVALID scripts) as RTL", () => {
    // Old Hungarian: U+10C80-U+10CFF. HarfBuzz's own rule is
    // HB_DIRECTION_INVALID ("can be written either direction"), not RTL —
    // the ticket's own worked list named it as a missing entry, and this is
    // the correction: adding it would have introduced a divergence from
    // Chrome, not fixed one.
    expect(isRtlScriptCodepoint(0x10c80)).toBe(false); // OLD HUNGARIAN CAPITAL LETTER A
    expect(isRtlScriptCodepoint(0x10cc0)).toBe(false); // OLD HUNGARIAN SMALL LETTER A
    expect(isRtlScriptCodepoint(0x10cfa)).toBe(false); // an Old Hungarian number sign
    for (const name of HB_INVALID_DIRECTION_SCRIPTS) {
      for (const [lo, hi] of smpRangesFor(name)) {
        expect(isRtlScriptCodepoint(lo), name).toBe(false);
        expect(isRtlScriptCodepoint(hi), name).toBe(false);
      }
    }
  });

  it("covers the scripts DM-2019 named as missing", () => {
    // One representative codepoint per newly-added script (ticket's list).
    expect(isRtlScriptCodepoint(0x10a60)).toBe(true); // Old South Arabian
    expect(isRtlScriptCodepoint(0x10a80)).toBe(true); // Old North Arabian
    expect(isRtlScriptCodepoint(0x10880)).toBe(true); // Nabataean
    expect(isRtlScriptCodepoint(0x10860)).toBe(true); // Palmyrene
    expect(isRtlScriptCodepoint(0x108e0)).toBe(true); // Hatran
    expect(isRtlScriptCodepoint(0x10900)).toBe(true); // Phoenician
    expect(isRtlScriptCodepoint(0x10920)).toBe(true); // Lydian
    expect(isRtlScriptCodepoint(0x10980)).toBe(true); // Meroitic Hieroglyphs
    expect(isRtlScriptCodepoint(0x109a0)).toBe(true); // Meroitic Cursive
    expect(isRtlScriptCodepoint(0x10b00)).toBe(true); // Avestan
    expect(isRtlScriptCodepoint(0x10b40)).toBe(true); // Inscriptional Parthian
    expect(isRtlScriptCodepoint(0x10b60)).toBe(true); // Inscriptional Pahlavi
    expect(isRtlScriptCodepoint(0x10b80)).toBe(true); // Psalter Pahlavi
    expect(isRtlScriptCodepoint(0x10c00)).toBe(true); // Old Turkic
  });

  it("also covers Cypriot and Imperial Aramaic — SMP RTL scripts the ticket's own list omitted", () => {
    // Found by transcribing HarfBuzz's full switch rather than the ticket's
    // prose list: both are HB_DIRECTION_RTL and both fall in the SMP, so a
    // literal reading of "port the missing scripts from the ticket" would
    // have left the table still incomplete.
    expect(isRtlScriptCodepoint(0x10800)).toBe(true); // Cypriot
    expect(isRtlScriptCodepoint(0x10840)).toBe(true); // Imperial Aramaic
  });

  it("stays SMP-only and false for plain Latin", () => {
    expect(isRtlScriptCodepoint(0x05d0)).toBe(false); // Hebrew alef — BMP, not covered
    expect(isRtlScriptCodepoint(0x0627)).toBe(false); // Arabic alef — BMP, not covered
    expect(isRtlScriptCodepoint(0x0041)).toBe(false); // Latin A
  });
});
describe("isHarfbuzzSameFontSpaceFallback", () => {
  it("transcribes HarfBuzz's same-face space fallback set", () => {
    for (const cp of [0x00A0, 0x2000, 0x2005, 0x200A, 0x202F, 0x205F]) {
      expect(isHarfbuzzSameFontSpaceFallback(cp)).toBe(true);
    }
  });

  it("leaves Blink's U+3000 exception and non-space characters to fallback", () => {
    for (const cp of [0x20, 0x1680, 0x200B, 0x3000, 0x41]) {
      expect(isHarfbuzzSameFontSpaceFallback(cp)).toBe(false);
    }
  });
});

describe("harfbuzzCanonicalDecompositionCandidates", () => {
  it("orders shortest canonical decompositions before fully expanded NFD", () => {
    expect(harfbuzzCanonicalDecompositionCandidates(0x1EDA)).toEqual([
      [0x01A0, 0x0301],
      [0x004F, 0x031B, 0x0301],
    ]);
  });

  it("includes mark-only decompositions and excludes Hangul", () => {
    expect(harfbuzzCanonicalDecompositionCandidates(0x0344)).toEqual([[0x0308, 0x0301]]);
    expect(harfbuzzCanonicalDecompositionCandidates(0xAC00)).toEqual([]);
  });
});
