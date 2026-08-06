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

// The Unicode `Ideographic` binary property, exactly as Blink consults it:
// `Character::IsIdeographic` is `u_hasBinaryProperty(c, UCHAR_IDEOGRAPHIC)`
// (external/chromium third_party/blink/renderer/platform/text/character.h:106-108,
// rev 7d859f27; identical at shipping tag 147.0.7727.15). JS regex `\p{Ideographic}`
// is the same UCD property, so this is a transcription, not an approximation.
// It gates Blink's macOS per-character fallback cache: caching happens ONLY for
// [:Ideographic=Yes:] codepoints (mac/font_cache_mac.mm:335-347).
const IDEOGRAPHIC_RE = /^\p{Ideographic}$/u;
export function isIdeographicCp(cp: number): boolean {
  let s: string;
  try { s = String.fromCodePoint(cp); } catch { return false; }
  return IDEOGRAPHIC_RE.test(s);
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
// rather than the Universal Shaping Engine. The set is exactly the shapers that
// exist as `hb-ot-shaper-*.cc` files: Indic, Thai(+Lao), Myanmar, Khmer,
// Arabic(+Syriac), Hebrew, Hangul. **Tibetan is not one of them** — the file
// does not exist and `HB_SCRIPT_TIBETAN` falls through to USE — and neither is
// Sinhala; both were listed here and both were wrong. These are EXCLUDED from the
// base+mark HarfBuzz rerouting below: the CoreText-vs-Chrome divergence that
// motivates it is a USE shaper behavior (its `NO_SHORT_CIRCUIT` normalization
// always decomposes), which the dedicated shapers don't trigger. The exclusion
// is NOT because CoreText matches Chrome on these blocks — measured, it does
// not in any of the ten scripts (see the block comment on
// `complexShaperBaseMarkDecomposition`) — but because that hook reroutes the
// OUTLINES along with the shaping, and swapping outline engines is a paint
// change in its own right. Scripts whose shaping has been moved to HarfBuzz
// with the outlines held fixed are listed in `HARFBUZZ_SHAPED_RANGES` below,
// and stay in this list too. Inclusive [lo, hi].
const DEDICATED_SHAPER_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0590, 0x05FF], // Hebrew
  [0x0600, 0x06FF], [0x0750, 0x077F], [0x0870, 0x089F], [0x08A0, 0x08FF], // Arabic + supplements
  // Indic: Devanagari … Malayalam. ENDS AT 0x0D7F, not 0x0DFF — HarfBuzz's
  // Indic group is exactly nine scripts (Bengali, Devanagari, Gujarati,
  // Gurmukhi, Kannada, Malayalam, Oriya, Tamil, Telugu — `hb-ot-shaper.hh:224-232`)
  // and **Sinhala is not one of them**. `HB_SCRIPT_SINHALA` (`:280`) sits in the
  // block that returns `_hb_ot_shaper_use` (`:414`), so Sinhala 0x0D80-0x0DFF
  // belongs to the USE side of this split.
  [0x0900, 0x0D7F],
  [0x0E00, 0x0EFF], // Thai + Lao
  // Tibetan is NOT here: there is no `hb-ot-shaper-tibetan.cc`, and
  // `HB_SCRIPT_TIBETAN` (`hb-ot-shaper.hh:276`) falls through to the same USE
  // return as Sinhala. Listing it excluded exactly the scripts USE's
  // `NO_SHORT_CIRCUIT` normalization decomposes — i.e. the case the base+mark
  // rerouting hook exists to serve — and made `resolveDottedCircleHbRun` bail.
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

// The subset of the dedicated-shaper blocks whose SHAPING is routed to HarfBuzz
// — the engine Chrome runs — instead of the platform shaper. The outlines are
// NOT routed with it: `resolveFontForCodepoint` builds the override with
// `outlinesFromBase: true`, so HarfBuzz supplies ids / positions / clusters and
// the platform engine still draws. Keeping those two apart is the whole reason
// this can be done at all; see the note on `harfbuzzShapedScriptOverride` in
// `font-resolution.ts` for the measurement that established it.
//
// Grown one script at a time, each with its own full macOS unicode sweep,
// because the blast radius of a script is every face that covers it. The order
// is by measured disagreement count, smallest first.
//
// Why this is a SEPARATE list rather than a narrowing of the one above:
// `usesDedicatedShaper` is read for two unrelated purposes, and only one of
// them is "the platform shaper is right here".
//
//   1. `text-to-path.ts`'s `isShapingRequired` — a dedicated-shaper script must
//      take the RUN-shaping branch rather than the per-character one. That stays
//      true after a reroute; dropping a script out of the list would silently
//      turn contextual shaping off for it, which is the opposite of the intent.
//   2. The two HarfBuzz-with-HarfBuzz-OUTLINES hooks below
//      (`complexShaperBaseMarkDecomposition`, and `resolveDottedCircleHbRun` in
//      `font-resolution.ts`). Those stay excluded for every script, rerouted or
//      not: a rerouted run is already shaped by HarfBuzz, so all they could add
//      is a change of outline ENGINE — measured at a 0.0940 → 0.1214 worst-tile
//      regression on the Thai fixture, and the reason `outlinesFromBase` exists.
const HARFBUZZ_SHAPED_RANGES: ReadonlyArray<readonly [number, number]> = [
  // Thai. Measured: 32 engine disagreements over 4 faces, 2 of them `glyph-ids`
  // — the U+F704 / U+F714 Windows-PUA shift-left forms of U+0E37 SARA UEE and
  // U+0E49 MAI THO, which HarfBuzz substitutes on an ascender base (PO PLA) and
  // CoreText does not. The rule is a state machine plus a mapping table, not a
  // heuristic: `external/harfbuzz/src/hb-ot-shaper-thai.cc` (rev 4de187d),
  // `thai_above_start_state` :172-179, `thai_above_state_machine` :188-189,
  // `SL_mappings` :124-137, `thai_pua_shape` :156-159. On Arial Unicode MS those
  // PUA entries are the plain outline shifted 220 units left — 0.107 em, ≈1.7 px
  // at 16 px — so Chrome paints a visibly different mark position from ours on
  // every Thai word with an above mark over an ascender.
  //
  // Lao (0E80–0EFF) is deliberately NOT included: it is a separate script with
  // its own samples, and nothing has been measured for it.
  [0x0E00, 0x0E7F],

  // Telugu. Measured: 10 engine disagreements over 3 faces on the conjunct
  // క్ష (KA + VIRAMA + SSA) — 6 `cluster`, 2 `advance`, 2 `offset`.
  //
  // Worth being precise about what this does and does not move, because the
  // shaped ink lands in the same place either way. On Kohinoor Telugu HarfBuzz
  // returns advances `516 0` with offsets `0,0` / `-248,32`, and CoreText
  // returns `268 248` with `0,0` / `0,32`. Both put the subjoined SSA's ink at
  // x = 268 and both total 516: HarfBuzz treats it as a zero-advance GPOS mark
  // attached back under the base, CoreText lays the two out sequentially. That
  // difference cancels within a shaped run.
  //
  // What does NOT cancel is the CLUSTER MAP — HarfBuzz reports `0 0`, CoreText
  // `0 1` — because the renderer anchors each cluster at its CAPTURED xOffset
  // rather than at an accumulated advance. A map that assigns the subjoined
  // glyph its own source index anchors it at the VIRAMA's captured x, which is
  // not where Chrome put it. Chrome gets HarfBuzz's map: the Indic shaper
  // merges a consonant syllable's clusters from the base outward
  // (`external/harfbuzz/src/hb-ot-shaper-indic.cc` rev 4de187d, :806 and
  // :824), so base and subjoined consonant share one cluster by construction.
  //
  // This is the case the ticket flagged as weaker evidence than a glyph
  // difference — correctly, and it is not zero evidence.
  [0x0C00, 0x0C7F],

  // Hangul: syllables, both Jamo blocks, and the compatibility block. Measured:
  // 2 engine disagreements, both `glyph-count`, both on the terminal LastResort
  // face — `한글` comes back as 2 glyphs from HarfBuzz and 6 from CoreText, i.e.
  // CoreText decomposes each precomposed syllable into its L / V / T jamo and
  // HarfBuzz does not.
  //
  // HarfBuzz's rule is a coverage test, not a preference
  // (`external/harfbuzz/src/hb-ot-shaper-hangul.cc` rev 4de187d, :344-357): a
  // precomposed <LV>/<LVT> syllable is decomposed only when the font LACKS the
  // composed glyph and covers all the jamo. LastResort's cmap covers the
  // syllable, so `has_glyph(s)` is true and the syllable stands. Chrome shapes
  // with HarfBuzz, so Chrome paints 2 glyphs; six jamo boxes where Chrome paints
  // two syllable boxes is a visibly different width, not a placement nuance.
  //
  // Every OTHER face that covers `한글` already agrees, so the reroute changes
  // nothing for real Korean faces (Apple SD Gothic Neo, PingFang, Arial Unicode)
  // and only corrects the terminal-fallback case.
  [0x1100, 0x11FF], [0x3130, 0x318F], [0xA960, 0xA97F], [0xAC00, 0xD7FF],

  // Devanagari. Measured: 44 engine disagreements over 5 faces (`devanagari`,
  // `u-noto-sans`, `u-arial-unicode-ms`, `u-itf-devanagari`, `last-resort`) —
  // 32 `cluster`, 6 `advance`, 6 `offset`, and **no `glyph-ids` or
  // `glyph-count` at all**. Both engines pick the same glyphs.
  //
  // The advance / offset pairs cancel, exactly as they do for Telugu. On the
  // `devanagari` key, र्क: HarfBuzz `770 0` with offsets `0,0` / `-248,0`,
  // CoreText `522 248` with `0,0` / `0,0` — both put the second glyph's ink at
  // 522 and both total 770. So this reroute is again about the CLUSTER MAP.
  //
  // Devanagari's map difference is larger than Telugu's because it is not just
  // coarser, it is REORDERED. On हिन्दी HarfBuzz reports `0 0 2 2` and CoreText
  // `1 0 2 5`: CoreText hands the pre-base matra ि its own source index and
  // orders it ahead of the base it was reordered around, where HarfBuzz merges
  // base and matra into one cluster. Since the renderer anchors each cluster at
  // its captured xOffset, a per-glyph map for a reordered matra anchors it at a
  // source position Chrome never painted it at. HarfBuzz's merge is the Indic
  // shaper's documented behavior — final reordering moves things before the
  // base and then merges clusters up to it, so the two merges interlock
  // (`external/harfbuzz/src/hb-ot-shaper-indic.cc` rev 4de187d, :796-806).
  //
  // Scoped to the Devanagari block proper. Devanagari Extended (A8E0–A8FF) is
  // deliberately excluded: it is not in `DEDICATED_SHAPER_RANGES` at all, so it
  // currently takes the USE / base+mark path, and nothing has been measured for
  // it. Vedic Extensions (1CD0–1CFF) likewise stay where DM-1160 put them.
  [0x0900, 0x097F],

  // Hebrew, plus the Alphabetic Presentation Forms block that is its other half.
  // Measured: 76 engine disagreements — the largest of the ten — over 14 faces
  // (SF Hebrew, all four Arial cuts, all four Times New Roman cuts, both Lucida
  // Grande cuts, Arial Unicode, LastResort): 27 `offset`, 26 `cluster`, 21
  // `advance`, 2 `glyph-count`. Nearly all of it is on the POINTED sample
  // בְּרֵאשִׁ; the unpointed שלום differs only in its cluster map.
  //
  // The advance / offset disagreements are two ENCODINGS of the same ink, and it
  // is worth writing out once because "27 offset differences" reads alarming and
  // is not. On Arial:
  //
  //     hb  adv  0 1422 1153 0 1043 0 1110    off 340,55  0,0  0,0  460,55  0,0  159,0  0,0
  //     ct  adv  -340 1422 1613 -460 1202 -159 1110       off 340,* on EVERY glyph
  //
  // HarfBuzz models each point as a ZERO-advance mark carrying its own offset;
  // CoreText carries one constant x offset on every glyph and folds the
  // difference into (sometimes negative) advances. Accumulating advance and
  // adding offset per glyph, both land the ink at 340 / 0 / 1422 / 3035 / 2575 /
  // 3777 / 3618 — identical. Only the run's total advance differs (4728 against
  // 4388), by exactly that constant offset, so the painted extent agrees too.
  //
  // What genuinely differs is again the CLUSTER MAP (hb `6 6 5 3 3 0 0` against
  // ct `8 6 5 4 3 2 0`), which the captured-xOffset anchoring reads, plus the 2
  // `glyph-count` on LastResort (7 glyphs against 9).
  //
  // FB1D-FB4F travels WITH the base block rather than being left behind — unlike
  // the extension blocks excluded above — because the Hebrew shaper COMPOSES
  // across the boundary: `compose_hebrew` maps a consonant U+05D0-05EA plus
  // U+05BC DAGESH onto its FB30-FB4A presentation form
  // (`external/harfbuzz/src/hb-ot-shaper-hebrew.cc` rev 4de187d, :35-72). Text
  // mixing the two would otherwise split into two runs on the routing key and be
  // shaped as two units, which is the failure mode this exercise exists to avoid.
  [0x0590, 0x05FF], [0xFB1D, 0xFB4F],

  // Arabic — the last of the six, and with it every script the measurement
  // found a glyph or position difference in. 75 disagreements over 10 faces
  // (SF Arabic / Geeza Pro, both Arial cuts, both Times New Roman cuts, Arial
  // Unicode, LastResort): 25 `advance`, 24 `offset`, 18 `cluster`, 8
  // `glyph-count`.
  //
  // The advance / offset pairs are the same two-encodings-of-one-ink situation
  // as Hebrew, and they cancel. On Geeza Pro, مرحبا: HarfBuzz `647 656 1359 700
  // 971` with a -202 offset on the fourth glyph, CoreText `647 656 1157 902 971`
  // with no offsets — both paint at 0 / 647 / 1303 / 2460 / 3362 and both total
  // 4333. On the pointed بِسْمِ CoreText again carries one constant offset on every
  // glyph and folds the rest into negative advances; accumulated, both land at
  // 216 / 0 / 947 / 692 / 1795 / 1779. So what is left is the cluster map (hb
  // `4 4 2 2 0 0` against ct `5 4 3 2 1 0`).
  //
  // **The 8 `glyph-count` disagreements look alarming and are unreachable.**
  // All 8 are on LastResort, where HarfBuzz returns ONE glyph for a whole
  // Arabic word (`مرحبا` → 1, `العربية` → 1) while CoreText returns one per
  // character. That is not a ligature in the font — LastResort has no GSUB or
  // `morx` at all, which is exactly what triggers HarfBuzz's Arabic FALLBACK
  // plan (`hb-ot-shaper-arabic.cc` rev 4de187d, :424-438). That plan builds a
  // synthetic GSUB in GLYPH-ID space from the shaping and ligature tables, and
  // LastResort maps every codepoint in a block to the SAME glyph id, so its
  // ligature entries all collide on one id and the run collapses. Latin and
  // Hangul are unaffected on the same face (`abc` stays 3 glyphs), confirming
  // it is the Arabic fallback plan and not a general property.
  //
  // Checked rather than assumed: `last-resort` is reached **0 times** out of
  // 7,680 codepoint × primary resolutions over all six Arabic ranges — the
  // static chain skips the key and Blink's macOS last-resort fallback is Times,
  // never the Unicode LastResort font (`mac/font_cache_mac.mm:376-392`). So
  // this collapse is not paint we can produce; and where it would be, Chrome
  // runs the same HarfBuzz and would collapse identically.
  //
  // All six ranges route together — Arabic proper, Supplement, Extended-A and
  // Extended-B are joining letters, and the two presentation-form blocks carry
  // joining types too, so routing a subset would split a word across two
  // shapers mid-join. That is the same reasoning as Hebrew's FB1D-FB4F.
  [0x0600, 0x06FF], [0x0750, 0x077F], [0x0870, 0x089F], [0x08A0, 0x08FF],
  [0xFB50, 0xFDFF], [0xFE70, 0xFEFF],
];

/** True when this codepoint's script has been rerouted to HarfBuzz shaping.
 *  See `HARFBUZZ_SHAPED_RANGES` for what that does and does not move. */
export function usesHarfbuzzShaping(cp: number): boolean {
  for (const [lo, hi] of HARFBUZZ_SHAPED_RANGES) {
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
// the DEFAULT shaper's composed Latin / Greek / Cyrillic diacritics (é, ñ, …) and
// the dedicated Indic / Tibetan / Myanmar shapers are left on the normal path.
//
// **The reason once given for the second exclusion — "which CoreText already
// matches" — is false, and was never measured.** `npm run fonts:shaper-ab` over
// every resolvable macOS face reports a disagreement in EVERY dedicated-shaper
// script, not one clean range (366 disagreements total):
//
//     hebrew  76   arabic 75   devanagari 44   thai   32   telugu 10
//     myanmar  6   bengali  4   khmer       4   tamil   2   hangul  2
//
// The *kind* is what still separates them, and it is the only defensible reason
// to keep any of them excluded. For **myanmar, bengali, khmer and tamil** every
// disagreement is `cluster` — the two engines produce the same glyph ids at the
// same positions and differ only in the source-index map. For **hebrew, arabic,
// devanagari, thai, telugu and hangul** the glyphs or their positions genuinely
// differ (`glyph-ids`, `advance`, `offset`, `glyph-count`), so on those the
// exclusion is resting on a claim the measurement contradicts.
//
// Note a cluster-only difference is NOT automatically invisible: the DM-1028
// path anchors each cluster at its captured xOffset, so the cluster map can move
// paint. It is weaker evidence of a paint difference than a glyph difference,
// not zero evidence.
//
// The exclusion is left in place here deliberately rather than narrowed on the
// strength of these counts alone — rerouting a script is a corpus-wide change
// that needs its own sweep, and one attempt already regressed a Thai fixture for
// a reason (the outline engine moving with the shaper) that had nothing to do
// with these numbers. What is fixed here is the false justification.
export function complexShaperBaseMarkDecomposition(cp: number): string | null {
  if (!usesComplexShaperDottedCircle(cp)) return null;
  // Dedicated shaper. NOT because CoreText matches Chrome there — measured, it
  // does not in any of the ten scripts — but because moving one is a sweep-sized
  // change; see the block comment above.
  if (usesDedicatedShaper(cp)) return null;
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
