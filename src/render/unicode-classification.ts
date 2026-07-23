/**
 * Unicode codepoint classification predicates, extracted from text-to-path.ts
 * (DM-1305 / DM-1307). Pure, stateless range-table lookups used by the shaping
 * + decoration pipeline: math-alphanumeric mapping, inkless/ignorable detection,
 * CJK trimmable punctuation, complex-shaper (dotted-circle / base-mark) ranges,
 * left-reordering matras, RTL SMP scripts, and stretchy math fences. Each range
 * table is private to its predicate. Behavior-identical lift.
 */

/**
 * Decompose a Mathematical Alphanumeric Symbols codepoint (U+1D400–U+1D7FF)
 * into its base letter / digit plus the implied bold / italic style.
 *
 * Why: Chromium does NOT carry a dedicated glyph for every Math-Alpha
 * codepoint on every platform. On the Linux Playwright image the system math
 * faces (FreeSans / FreeSerif) have no U+1D4xx coverage at all — a probe
 * confirmed `FreeSansOblique` lacks the entire block — so Chromium paints
 * e.g. 𝑎 (U+1D44E) by synthesizing it from the *base* italic letter `a` in
 * the already-oblique face. fontkit returns `.notdef` for the math codepoint
 * for the same reason the cmap lacks it, so without this the renderer drops
 * the glyph to a `<text>` element. When the whole fallback chain comes up
 * empty for a Math-Alpha codepoint we map it back to its base char + style
 * and render that base glyph in the matching weight / slant face — matching
 * what Chromium actually painted. (macOS/Windows are unaffected: STIX Two
 * Math / Cambria Math cover U+1D4xx, so the chain finds the glyph and this
 * path never runs.)
 *
 * Covers the styles that reduce to a bold/italic toggle of a base Latin/Greek
 * letter or digit: bold, italic, bold-italic, the four sans-serif variants,
 * and monospace, plus the Greek symbol variants and the U+210E (ℎ) hole the
 * capture emits for italic lowercase h. The script / fraktur / double-struck
 * styles are distinct typefaces that can't be faithfully synthesized from a
 * base letter, so they return `null` (the caller keeps the pre-existing
 * chain behavior for those).
 *
 * Exported for unit tests.
 */
export function mathAlphaToBase(cp: number): { base: number; bold: boolean; italic: boolean } | null {
  // PLANCK CONSTANT (U+210E): Unicode reuses this for Mathematical Italic
  // small h (the U+1D455 slot is unassigned), and the capture emits it for
  // `<mi>h</mi>`. Decompose it back to an italic `h`.
  if (cp === 0x210e) return { base: 0x68, bold: false, italic: true };
  if (cp < 0x1d400 || cp > 0x1d7ff) return null;

  // Latin alphabet styles. Each is 52 contiguous codepoints (A–Z then a–z),
  // except the styles flagged below that borrow letters from the Letterlike
  // Symbols block (script / fraktur / double-struck) — those are skipped.
  const latin: Array<{ start: number; bold: boolean; italic: boolean } | null> = [
    { start: 0x1d400, bold: true,  italic: false }, // Bold
    { start: 0x1d434, bold: false, italic: true  }, // Italic (small-h hole → U+210E, handled above)
    { start: 0x1d468, bold: true,  italic: true  }, // Bold Italic
    null,                                           // Script
    null,                                           // Bold Script
    null,                                           // Fraktur
    null,                                           // Double-struck
    null,                                           // Bold Fraktur
    { start: 0x1d5a0, bold: false, italic: false }, // Sans-serif
    { start: 0x1d5d4, bold: true,  italic: false }, // Sans-serif Bold
    { start: 0x1d608, bold: false, italic: true  }, // Sans-serif Italic
    { start: 0x1d63c, bold: true,  italic: true  }, // Sans-serif Bold Italic
    { start: 0x1d670, bold: false, italic: false }, // Monospace
  ];
  for (const style of latin) {
    if (style == null) continue;
    const off = cp - style.start;
    if (off < 0 || off > 51) continue;
    const base = off < 26 ? 0x41 + off : 0x61 + (off - 26);
    return { base, bold: style.bold, italic: style.italic };
  }

  // Greek styles. Each block is 58 (0x3A) contiguous codepoints with the same
  // internal layout: 25 uppercase (Α…Ω), ∇, 25 lowercase (α…ω), then 7 symbol
  // variants (∂ ϵ ϑ ϰ ϕ ϱ ϖ). The decomposition is the exact inverse of the
  // capture's mathvariant=italic mapping for the italic block, applied to all
  // five bold/italic/sans Greek styles.
  const greek: Array<{ start: number; bold: boolean; italic: boolean }> = [
    { start: 0x1d6a8, bold: true,  italic: false }, // Bold
    { start: 0x1d6e2, bold: false, italic: true  }, // Italic
    { start: 0x1d71c, bold: true,  italic: true  }, // Bold Italic
    { start: 0x1d756, bold: true,  italic: false }, // Sans-serif Bold
    { start: 0x1d790, bold: true,  italic: true  }, // Sans-serif Bold Italic
  ];
  const greekSymbols = [0x2202, 0x3f5, 0x3d1, 0x3f0, 0x3d5, 0x3f1, 0x3d6]; // ∂ ϵ ϑ ϰ ϕ ϱ ϖ
  for (const style of greek) {
    const off = cp - style.start;
    if (off < 0 || off > 57) continue;
    let base: number;
    if (off <= 24) base = 0x391 + off;            // uppercase Α…Ω
    else if (off === 25) base = 0x2207;            // ∇ nabla
    else if (off <= 50) base = 0x3b1 + (off - 26); // lowercase α…ω
    else base = greekSymbols[off - 51];            // symbol variants
    return { base, bold: style.bold, italic: style.italic };
  }

  // Digit styles (U+1D7CE–U+1D7FF). Double-struck (1D7D8) is a distinct
  // typeface → skipped; the rest reduce to a bold/normal toggle of 0–9.
  const digits: Array<{ start: number; bold: boolean } | null> = [
    { start: 0x1d7ce, bold: true  }, // Bold
    null,                            // Double-struck
    { start: 0x1d7e2, bold: false }, // Sans-serif
    { start: 0x1d7ec, bold: true  }, // Sans-serif Bold
    { start: 0x1d7f6, bold: false }, // Monospace
  ];
  for (const style of digits) {
    if (style == null) continue;
    const off = cp - style.start;
    if (off < 0 || off > 9) continue;
    return { base: 0x30 + off, bold: style.bold, italic: false };
  }

  return null;
}

// High-confidence "this codepoint never paints ink" set: control (Cc), format
// (Cf), line/paragraph/space separators (Zl/Zp/Zs), the invisible math
// operators (Sm but inkless), variation selectors, and tags. fontkit correctly
// returns an empty outline for these, so they must NOT trigger the helper —
// otherwise ordinary text (a narrow no-break space, a bidi control) would spawn
// the helper / trigger the DM-886 download for no reason. Empirically (DM-891),
// every macOS glyph fontkit returns empty for falls in this set, and the helper
// agrees they're empty — so the fallback is inert on macOS by design and only
// fires for a genuinely-undecodable inkable glyph (Linux/Windows CFF/CJK).
const INKLESS_CATEGORY_RE = /^[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}]$/u;
export function isLegitimatelyInklessCodepoint(cp: number): boolean {
  let s: string;
  try { s = String.fromCodePoint(cp); } catch { return false; }
  if (INKLESS_CATEGORY_RE.test(s)) return true;
  if (cp >= 0x2061 && cp <= 0x2064) return true;   // invisible math operators
  if (cp >= 0xFE00 && cp <= 0xFE0F) return true;    // variation selectors
  if (cp >= 0xE0100 && cp <= 0xE01EF) return true;  // variation selectors supplement
  if (cp >= 0xE0000 && cp <= 0xE007F) return true;  // tags
  return false;
}

// CJK fullwidth-punctuation blocks whose glyphs carry trimmable side-bearing.
// The real filtering is done by `haltInfoFor` (must have a half-width alternate)
// plus the captured-advance check; this just scopes the probe so it never runs
// for ordinary ideographs / Latin.
export function isTrimmableCjkPunct(cp: number): boolean {
  return (cp >= 0x3000 && cp <= 0x303F)   // CJK Symbols and Punctuation (、。「」（） …)
    || (cp >= 0xFF00 && cp <= 0xFF60)      // Fullwidth ASCII variants (（）！？： …)
    || (cp >= 0xFFE0 && cp <= 0xFFEE);     // Fullwidth signs
}

// DM-1026: Unicode blocks whose script uses a COMPLEX shaper (Indic / Khmer /
// Myanmar / SE-Asian Brahmic / the Universal Shaping Engine) — the shapers that,
// like Chrome's HarfBuzz, insert a dotted circle (U+25CC) before an ORPHANED
// combining mark (a mark with no base in its cluster). The generic combining-
// mark blocks (Combining Diacritical Marks 0300–036F, …-Extended 1AB0–1AFF,
// …-Supplement 1DC0–1DFF, …-for-Symbols 20D0–20FF, Half Marks FE20–FE2F) are
// DELIBERATELY ABSENT: those route through the DEFAULT shaper, which paints the
// bare mark with NO dotted circle (so DM-1027's Latin combining marks correctly
// get none). Ranges are inclusive [start, end]. Kept as a flat sorted list — the
// gate only runs for an uncovered category-M codepoint, which is rare.
const COMPLEX_SHAPER_MARK_RANGES: ReadonlyArray<readonly [number, number]> = [
  // BMP Indic / SE-Asian
  [0x0900, 0x097F], [0x0980, 0x09FF], [0x0A00, 0x0A7F], [0x0A80, 0x0AFF],
  [0x0B00, 0x0B7F], [0x0B80, 0x0BFF], [0x0C00, 0x0C7F], [0x0C80, 0x0CFF],
  [0x0D00, 0x0D7F], [0x0D80, 0x0DFF], [0x0E00, 0x0E7F], [0x0E80, 0x0EFF],
  [0x0F00, 0x0FFF], [0x1000, 0x109F], [0x1700, 0x171F], [0x1720, 0x173F],
  [0x1740, 0x175F], [0x1760, 0x177F], [0x1780, 0x17FF], [0x1900, 0x194F],
  [0x1980, 0x19DF], [0x1A00, 0x1A1F], [0x1A20, 0x1AAF], [0x1B00, 0x1B7F],
  [0x1B80, 0x1BBF], [0x1BC0, 0x1BFF], [0x1C00, 0x1C4F], [0x1CD0, 0x1CFF],
  [0xA800, 0xA82F], [0xA880, 0xA8DF], [0xA8E0, 0xA8FF], [0xA900, 0xA92F],
  [0xA930, 0xA95F], [0xA980, 0xA9DF], [0xA9E0, 0xA9FF], [0xAA00, 0xAA5F],
  [0xAA60, 0xAA7F], [0xAA80, 0xAADF], [0xAAE0, 0xAAFF], [0xABC0, 0xABFF],
  // SMP Brahmic (all USE)
  [0x10A00, 0x10A5F], [0x11000, 0x1107F], [0x11080, 0x110CF], [0x110D0, 0x110FF],
  [0x11100, 0x1114F], [0x11150, 0x1117F], [0x11180, 0x111DF], [0x11200, 0x1124F],
  [0x11280, 0x112AF], [0x112B0, 0x112FF], [0x11300, 0x1137F], [0x11380, 0x113FF], [0x11400, 0x1147F],
  [0x11480, 0x114DF], [0x11580, 0x115FF], [0x11600, 0x1165F], [0x11680, 0x116CF],
  [0x11700, 0x1174F], [0x11800, 0x1184F], [0x11900, 0x1195F], [0x119A0, 0x119FF],
  [0x11A00, 0x11A4F], [0x11A50, 0x11AAF], [0x11C00, 0x11C6F], [0x11C70, 0x11CBF],
  [0x11D00, 0x11D5F], [0x11D60, 0x11DAF], [0x11EE0, 0x11EFF], [0x11F00, 0x11F5F],
  // Gurung Khema (16100–1613F) shapes through the Universal Shaping Engine, so
  // Chrome inserts U+25CC before an orphaned mark in this no-font block just as
  // it does for the others above. (Was previously omitted, so its mark cells
  // painted a bare tofu with no leading dotted circle — DM-1100.)
  [0x16100, 0x1613F],
];

export function usesComplexShaperDottedCircle(cp: number): boolean {
  for (const [lo, hi] of COMPLEX_SHAPER_MARK_RANGES) {
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

// DM-1197: Unicode blocks whose script HarfBuzz shapes with a DEDICATED shaper
// (Indic / Thai-Lao / Tibetan / Myanmar / Khmer / Arabic / Hebrew / Hangul-Jamo)
// rather than the Universal Shaping Engine. These are EXCLUDED from the HarfBuzz
// rerouting below: the CoreText-vs-Chrome divergence that motivates it is a USE
// shaper behavior (its `NO_SHORT_CIRCUIT` normalization always decomposes), while
// the dedicated shapers don't trigger it — macOS CoreText already matches Chrome
// for them (verified: the devanagari / bengali / gurmukhi / oriya / tamil /
// myanmar / tibetan unicode fixtures all PASS on the CoreText path). And
// harfbuzzjs's dedicated-shaper output can itself diverge from Chrome's paint —
// e.g. it decomposes Tibetan U+0F43 (`[82,199]`) where Chrome and the `hb-shape`
// CLI render the precomposed glyph (`[gh.]`), which regressed the tibetan fixture
// until this exclusion was added. Inclusive [lo, hi].
const DEDICATED_SHAPER_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0590, 0x05FF], // Hebrew
  [0x0600, 0x06FF], [0x0750, 0x077F], [0x0870, 0x089F], [0x08A0, 0x08FF], // Arabic + supplements
  [0x0900, 0x0DFF], // Indic: Devanagari … Sinhala
  [0x0E00, 0x0EFF], // Thai + Lao
  [0x0F00, 0x0FFF], // Tibetan
  [0x1000, 0x109F], // Myanmar
  [0x1780, 0x17FF], [0x19E0, 0x19FF], // Khmer
  [0x1100, 0x11FF], [0x3130, 0x318F], [0xA960, 0xA97F], [0xAC00, 0xD7FF], // Hangul (Jamo / Compat / Ext-B / Syllables)
  [0xAA60, 0xAA7F], [0xA9E0, 0xA9FF], [0x116D0, 0x116FF], // Myanmar Extended A/B/C
  [0xFB1D, 0xFB4F], [0xFB50, 0xFDFF], [0xFE70, 0xFEFF], // Hebrew/Arabic presentation forms
];
export function usesDedicatedShaper(cp: number): boolean {
  for (const [lo, hi] of DEDICATED_SHAPER_RANGES) {
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

// DM-1197: a UNIVERSAL-SHAPING-ENGINE PRECOMPOSED letter whose canonical NFD is a
// base followed by combining mark(s) — e.g. Kaithi U+110AB VA = U+110A5 BA +
// U+110BA NUKTA. These are exactly the codepoints where Chrome's HarfBuzz USE
// shaper (NO_SHORT_CIRCUIT, `hb-ot-shaper-use.cc`) decomposes + GPOS-positions the
// mark, while macOS CoreText recomposes to the precomposed glyph (whose built-in
// mark sits in a different place). `harfbuzzShapeRun` is routed in for these.
// Returns the NFD string (used only to coverage-check the decomposed pieces), or
// null. Scoped to complex-shaper blocks MINUS the dedicated-shaper ones, so both
// the DEFAULT shaper's composed Latin / Greek / Cyrillic diacritics (é, ñ, …) AND
// the dedicated Indic / Tibetan / Myanmar shapers (which CoreText already matches)
// are left on the normal path.
export function complexShaperBaseMarkDecomposition(cp: number): string | null {
  if (!usesComplexShaperDottedCircle(cp)) return null;
  if (usesDedicatedShaper(cp)) return null;              // dedicated shaper — CoreText already matches Chrome
  return nfdBaseMarkDecomposition(cp);
}

// A codepoint whose canonical NFD is a base followed by combining mark(s) —
// script-agnostic (the complex-shaper variant above adds USE-block gating on
// top of this). This is exactly the shape HarfBuzz's normalizer
// (`hb-ot-shape-normalize.cc`, `decompose_current_character`) decomposes when
// the current font lacks the PRECOMPOSED glyph but covers the pieces: e.g.
// U+21AE ↮ → U+2194 ↔ + U+0338 COMBINING LONG SOLIDUS OVERLAY. Returns the NFD
// string, or null when `cp` has no canonical decomposition, decomposes to a
// singleton, or the last element isn't a combining mark (so Hangul base+jamo
// LV/LVT decompositions — jamo are Lo, not M — stay excluded).
export function nfdBaseMarkDecomposition(cp: number): string | null {
  const ch = String.fromCodePoint(cp);
  const nfd = ch.normalize("NFD");
  if (nfd === ch) return null;                           // no canonical decomposition
  const cps = [...nfd];
  if (cps.length < 2) return null;                       // singleton — not a base+mark case
  if (/\p{M}/u.test(cps[0])) return null;                // first element must be a base
  if (!/\p{M}/u.test(cps[cps.length - 1])) return null;  // last element must be a combining mark
  return nfd;
}

// DM-1109: pre-base (LEFT) matras — VOWEL SIGNS the Universal Shaping Engine
// reorders to BEFORE their base. The set is the INTERSECTION of Unicode
// IndicPositionalCategory (UCD 18.0) "Left" placement (all six categories whose
// placement includes a Left component: Left / Top_And_Left / Bottom_And_Left /
// Top_And_Bottom_And_Left / Left_And_Right / Top_And_Left_And_Right) with
// IndicSyllabicCategory = Vowel_Dependent. The Vowel_Dependent filter is
// essential: USE pre-base reordering applies to pre-base VOWELS, not to MEDIAL
// CONSONANTS that merely sit to the left (e.g. Gurung Khema U+1612A/B MEDIAL
// YA/VA, Myanmar U+103C medial ra, Ahom U+1171E) — those are InPC=Left but
// Chrome paints them post-base ("◌ mark"), so flipping them was wrong (it
// regressed the gurung-khema fixture from clean to a 2-region diff before the
// filter was added).
//
// When `insertSyntheticDottedCircles` synthesizes a ◌ base for an orphaned,
// uncovered such matra, Chrome (USE) paints "mark ◌" (☐○), not "◌ mark". Verified
// against Chrome's painted output for the Tulu-Tigalari block: U+113C5 (Left
// vowel) and U+113C7/C8 (Left_And_Right vowels) all paint tofu-then-circle,
// while U+113C9 (Right vowel) paints circle-then-tofu. (Two-part Left_And_Right
// vowels render as a single .notdef tofu on the no-font path, so they reorder
// wholesale like a pure Left matra.) Flat sorted ranges, inclusive [lo, hi];
// only consulted for an already-qualified orphaned uncovered mark, so the linear
// scan is cheap.
const LEFT_REORDER_MATRA_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x93F, 0x93F], [0x94E, 0x94E], [0x9BF, 0x9BF], [0x9C7, 0x9C8],
  [0x9CB, 0x9CC], [0xA3F, 0xA3F], [0xABF, 0xABF], [0xB47, 0xB48],
  [0xB4B, 0xB4C], [0xBC6, 0xBC8], [0xBCA, 0xBCC], [0xD46, 0xD48],
  [0xD4A, 0xD4C], [0xDD9, 0xDDE], [0x1031, 0x1031], [0x1084, 0x1084],
  [0x17BE, 0x17C5], [0x1A19, 0x1A19], [0x1A6E, 0x1A72], [0x1B3E, 0x1B41],
  [0x1BA6, 0x1BA6], [0x1C27, 0x1C29], [0xA9BA, 0xA9BB], [0xAA2F, 0xAA30],
  [0xAAEB, 0xAAEB], [0xAAEE, 0xAAEE], [0x110B1, 0x110B1], [0x1112C, 0x1112C],
  [0x111B4, 0x111B4], [0x111CE, 0x111CE], [0x112E1, 0x112E1], [0x11347, 0x11348],
  [0x1134B, 0x1134C], [0x113C2, 0x113C2], [0x113C5, 0x113C5], [0x113C7, 0x113C8],
  [0x11436, 0x11436], [0x114B1, 0x114B1], [0x114B9, 0x114B9], [0x114BB, 0x114BC],
  [0x114BE, 0x114BE], [0x115B0, 0x115B0], [0x115B8, 0x115BB], [0x116AE, 0x116AE],
  [0x11726, 0x11726], [0x1182D, 0x1182D], [0x11935, 0x11935], [0x11937, 0x11938],
  [0x119D2, 0x119D2], [0x119E4, 0x119E4], [0x11CB1, 0x11CB1], [0x11EF5, 0x11EF5],
  [0x11F3E, 0x11F3F],
];

export function isLeftReorderingMatra(cp: number): boolean {
  for (const [lo, hi] of LEFT_REORDER_MATRA_RANGES) {
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

// DM-1215: right-to-left SMP scripts that bear combining marks. When the
// synthetic dotted circle is inserted for an orphaned mark in one of these,
// Chrome paints the cell RTL — "mark ◌" (tofu LEFT, circle RIGHT) — not the
// LTR "◌ mark". The mark renders at the cell origin and the ◌ to its right,
// the same layout the pre-base left-matra branch uses. Inclusive [lo, hi].
// (BMP RTL scripts — Hebrew / Arabic / Syriac / Thaana — keep the existing
// non-synthetic paths and are intentionally out of scope here.)
const RTL_SMP_SCRIPT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x10A00, 0x10A5F], // Kharoshthi
  [0x10AC0, 0x10AFF], // Manichaean
  [0x10D00, 0x10D3F], // Hanifi Rohingya
  [0x10D40, 0x10D8F], // Garay
  [0x10E80, 0x10EBF], // Yezidi
  [0x10EC0, 0x10EFF], // Arabic Extended-C
  [0x10F00, 0x10F2F], // Old Sogdian
  [0x10F30, 0x10F6F], // Sogdian
  [0x10F70, 0x10FAF], // Old Uyghur
  [0x10FB0, 0x10FDF], // Chorasmian
  [0x10FE0, 0x10FFF], // Elymaic
  [0x1E800, 0x1E8DF], // Mende Kikakui
  [0x1E900, 0x1E95F], // Adlam
  [0x1EC70, 0x1ECBF], // Indic Siyaq Numbers
  [0x1ED00, 0x1ED4F], // Ottoman Siyaq Numbers
  [0x1EE00, 0x1EEFF], // Arabic Mathematical Alphabetic Symbols
];

export function isRtlScriptCodepoint(cp: number): boolean {
  for (const [lo, hi] of RTL_SMP_SCRIPT_RANGES) {
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

// DM-1026: synthesize the dotted circle (U+25CC) Chrome's HarfBuzz inserts
// before an ORPHANED combining mark that NO font covers — e.g. the "no font"
// Brahmic blocks (Soyombo, Zanabazar, Devanagari-Extended, …) where each mark
// cell paints "◌ + .notdef tofu", ~51 px wide, while we previously painted just
// the bare tofu. Returns the input text/xOffsets augmented with a leading U+25CC
// for each qualifying mark; a no-op (returns the inputs) when the text has no
// combining marks. The ◌ is itself covered (Hiragino etc.), so it routes and
// renders through the normal pipeline — only the INSERTION is synthetic.
//
// DM-1158: code points HarfBuzz/Chrome treat as default-ignorable AND hide
// entirely (zero-width, no glyph) when the font lacks them — variation
// selectors, variation selectors supplement, and language tags. Unlike a
// genuinely-missing inkable glyph (which Chrome paints as a .notdef tofu),
// these paint NOTHING when uncovered. Our fallback chain otherwise routes an
// orphaned, uncovered one to the CoreText last-resort box, so each painted a
// tofu (the FE00-FE0F variation-selector fixture rendered a box per cell).
// Deliberately narrow: separators (spaces) keep their width and joiners
// (ZWJ/ZWNJ) carry shaping meaning, so neither is in scope here.
export function isStrippableOrphanIgnorable(cp: number): boolean {
  return (cp >= 0xFE00 && cp <= 0xFE0F)      // variation selectors
      || (cp >= 0xE0100 && cp <= 0xE01EF)    // variation selectors supplement
      || (cp >= 0xE0000 && cp <= 0xE007F);   // tags
}

/**
 * The Unicode characters that MathML treats as vertically-stretchy fences /
 * brackets by default (a focused subset of the operator dictionary's
 * `stretchy` entries). Chromium paints these centered on the math axis and
 * stretched to wrap their content, which `renderStretchyFenceGlyph` reproduces
 * by fitting the glyph to the captured `<mo>` box rather than the text
 * baseline. (DM-874)
 */
const STRETCHY_FENCE_CHARS = new Set([
  "(", ")", "[", "]", "{", "}", "|", "‖",
  "⌈", "⌉", "⌊", "⌋", "⟨", "⟩", "⎰", "⎱", "❲", "❳",
]);

/** True when `text` is a single stretchy MathML fence / bracket character. */
export function isStretchyFenceChar(text: string): boolean {
  return STRETCHY_FENCE_CHARS.has(text.trim());
}
