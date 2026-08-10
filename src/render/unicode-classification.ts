/**
 * Unicode codepoint classification predicates, extracted from text-to-path.ts
 * (DM-1305 / DM-1307). Pure, stateless range-table lookups used by the shaping
 * + decoration pipeline: math-alphanumeric mapping, inkless/ignorable detection,
 * CJK trimmable punctuation, complex-shaper (dotted-circle / base-mark) ranges,
 * left-reordering matras, RTL SMP scripts, and stretchy math fences. Each range
 * table is private to its predicate. Behavior-identical lift.
 */

import { HARFBUZZ_DEFAULT_IGNORABLE_RANGES } from "./harfbuzz-default-ignorable-ranges.generated.js";
import { USE_LEFT_MATRA_RANGES } from "./use-left-matra-ranges.generated.js";

/** True when `cp` is in HarfBuzz's `is_default_ignorable` set — see
 *  `harfbuzz-default-ignorable-ranges.generated.ts` for the transcription +
 *  provenance. This is NOT the Unicode `Cf` general category or the UCD
 *  `Default_Ignorable_Code_Point` property; both are broader than what
 *  HarfBuzz actually hides. */
export function isHarfbuzzDefaultIgnorable(cp: number): boolean {
  for (const [lo, hi] of HARFBUZZ_DEFAULT_IGNORABLE_RANGES) {
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

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

// High-confidence "this codepoint never paints ink" set: control (Cc),
// line/paragraph/space separators (Zl/Zp/Zs) — categories where fontkit
// correctly returns an empty outline on every macOS glyph tested (DM-891) —
// UNION HarfBuzz's own default-ignorable table (`isHarfbuzzDefaultIgnorable`,
// covering ZWSP/ZWJ/ZWNJ, bidi controls, variation selectors + supplement,
// tags, soft hyphen, CGJ, the Mongolian FVS block, and the musical-notation
// format controls).
//
// DM-2020: this deliberately does NOT include the general Unicode `Cf`
// (Format) category, which it did until this fix. `Cf` is broader than
// "never paints ink" — U+06DD ARABIC END OF AYAH ۝, U+0600-0605 (Arabic
// number-sign marks), U+070F SYRIAC ABBREVIATION MARK, U+0890/0891, U+08E2,
// U+FFF9-FFFB (interlinear annotation anchors), U+110BD/110CD (Kaithi
// number signs), U+13430-1343F (Egyptian Hieroglyph format controls) and
// U+1BCA0-1BCA3 (Shorthand Format controls, explicitly excluded by
// HarfBuzz's own table comment) are all `Cf` and all carry a real, visible
// glyph in fonts that support their script — HarfBuzz does not hide them
// (`hb-unicode.hh:167-198`, rev 4de187d). Blanket-matching `Cf` suppressed
// emission of U+06DD's glyph in the embedded-font render path even though a
// real Arabic face (e.g. macOS GeezaPro) has ink for it — the bug this
// predicate now no longer produces the affected 36-codepoint set for
// (enumerated offline against `isHarfbuzzDefaultIgnorable`, not sampled).
const INKLESS_CATEGORY_RE = /^[\p{Cc}\p{Zl}\p{Zp}\p{Zs}]$/u;
export function isLegitimatelyInklessCodepoint(cp: number): boolean {
  let s: string;
  try { s = String.fromCodePoint(cp); } catch { return false; }
  if (INKLESS_CATEGORY_RE.test(s)) return true;
  return isHarfbuzzDefaultIgnorable(cp);
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
//
// Thai (0x0E00-0x0E7F) and Lao (0x0E80-0x0EFF) are likewise DELIBERATELY
// ABSENT — both were here until this fix, and the pairing turns out to have
// been wrong. `HB_SCRIPT_THAI` and `HB_SCRIPT_LAO` both dispatch to the SAME
// dedicated shaper (`hb-ot-shaper.hh:205-208`, rev 4de187d — both `case`s fall
// through to `return &_hb_ot_shaper_thai;`), and that shaper
// (`hb-ot-shaper-thai.cc`) contains no `0x25CC` / dotted-circle reference at
// all (grepped the full file, rev 4de187d — zero matches). Thai/Lao's PUA
// mark-reordering state machine (`SL_mappings`, `thai_pua_shape`) shifts a
// mark glyph's OUTLINE; it never inserts a circle glyph. So an orphaned,
// uncovered Thai/Lao mark paints as a bare tofu in Chrome, and this table's
// membership was making Domotion draw a circle Chrome never draws.
const COMPLEX_SHAPER_MARK_RANGES: ReadonlyArray<readonly [number, number]> = [
  // BMP Indic / SE-Asian
  [0x0900, 0x097F], [0x0980, 0x09FF], [0x0A00, 0x0A7F], [0x0A80, 0x0AFF],
  [0x0B00, 0x0B7F], [0x0B80, 0x0BFF], [0x0C00, 0x0C7F], [0x0C80, 0x0CFF],
  [0x0D00, 0x0D7F], [0x0D80, 0x0DFF],
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

// DM-1197: Unicode blocks whose script needs RUN-based shaping rather than
// Domotion's per-character fallback (`text-to-path.ts`'s `isShapingRequired`
// gate — a member's whole run goes through `font.layout(runText, …, dir)` as a
// unit so contextual joining, cluster reordering, and ligatures survive,
// instead of one `font.layout(ch)` call per character with no shaping at all).
// Originally scoped to exactly HarfBuzz's TRUE dedicated shapers — the scripts
// with their own `hb-ot-shaper-*.cc` file: Indic, Thai(+Lao), Myanmar, Khmer,
// Arabic(+Syriac), Hebrew, Hangul. **Tibetan is not one of them** — the file
// does not exist and `HB_SCRIPT_TIBETAN` falls through to USE — and neither is
// Sinhala; both were listed here once and both were wrong for the ORIGINAL
// purpose below.
//
// DM-2033 / DM-2054 (read against `external/harfbuzz` 4de187d) extended the
// list to specific Universal-Shaping-Engine scripts too — Sinhala, N'Ko,
// Mandaic, Phags-pa, Manichaean, Psalter Pahlavi, Adlam, Kharoshthi, Hanifi
// Rohingya — because `isShapingRequired` needs "does this script need a
// whole-run `font.layout` call", which is true for every non-default shaper
// HarfBuzz dispatches to (`hb_ot_shaper_categorize`, `hb-ot-shaper.hh:181-415`
// — USE and the true dedicated shapers are both non-default), not just the
// dedicated ones. A run whose script isn't here still gets per-character
// `font.layout(ch)` calls with no contextual shaping at all, which is what
// left these scripts silently un-shaped even after DM-2007 fixed the bidi
// level bug that was blamed for it — the run never reached the branch that
// would have used the corrected levels.
//
// These are EXCLUDED from the base+mark HarfBuzz rerouting below (both the
// original dedicated-shaper members and the USE additions): the
// CoreText-vs-Chrome divergence that motivates that hook is a USE shaper
// behavior (its `NO_SHORT_CIRCUIT` normalization always decomposes), which a
// run ALREADY taking this list's whole-run shaping branch doesn't need routed
// through a second, single-codepoint HarfBuzz hook — see the `HARFBUZZ_SHAPED_
// RANGES` comment below, point 2. Verified NOT to silently drop coverage for
// the two new members that could have hit it: Sinhala's four NFD-decomposable
// codepoints (U+0DDA/DDC/DDD/DDE) already return null from
// `complexShaperBaseMarkDecomposition` via the unrelated base-first filter
// (their canonical decomposition is MARK+MARK, not base+mark), and Kharoshthi
// (the only other new member inside `COMPLEX_SHAPER_MARK_RANGES`) has ZERO
// codepoints with any canonical NFD decomposition at all — checked
// exhaustively over both blocks, not assumed. So this list's expansion changes
// that hook's observable output for neither. Scripts whose shaping has ALSO
// been moved to real HarfBuzz (harfbuzzjs) with the outlines held fixed are
// listed in `HARFBUZZ_SHAPED_RANGES` below, and stay in this list too.
// Inclusive [lo, hi].
const DEDICATED_SHAPER_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0590, 0x05FF], // Hebrew
  [0x0600, 0x06FF], [0x0750, 0x077F], [0x0870, 0x089F], [0x08A0, 0x08FF], // Arabic + supplements
  // Indic: Devanagari … Malayalam. ENDS AT 0x0D7F, not 0x0DFF — HarfBuzz's
  // Indic group is exactly nine scripts (Bengali, Devanagari, Gujarati,
  // Gurmukhi, Kannada, Malayalam, Oriya, Tamil, Telugu — `hb-ot-shaper.hh:224-232`)
  // and **Sinhala is not one of them**. `HB_SCRIPT_SINHALA` (`:280`) sits in the
  // block that returns `_hb_ot_shaper_use` (`:414`), so Sinhala 0x0D80-0x0DFF
  // is listed separately below, on the USE side of that split.
  [0x0900, 0x0D7F],
  // Sinhala. USE-shaped (`hb-ot-shaper.hh:280,414`), not Indic-shaped — see the
  // comment on the Indic range above. DM-2033: measured fontkit-vs-harfbuzzjs
  // shaping agreement on the block's actual darwin production face (Sinhala
  // Sangam MN) over a ZWJ-mediated conjunct (ශ්‍රී), a plain consonant+vowel-signs
  // word (කන්නඩ), and an out-of-order vowel-sign-before-base case (ේක) — all
  // three agreed byte-for-byte on glyph ids, advances and offsets. So this
  // entry's effect today is purely "isShapingRequired becomes true, contextual
  // joining reaches the block" — `HARFBUZZ_SHAPED_RANGES` stays un-touched for
  // it because nothing measured diverges yet.
  [0x0D80, 0x0DFF],
  [0x0E00, 0x0EFF], // Thai + Lao
  // Tibetan is NOT here: there is no `hb-ot-shaper-tibetan.cc`, and
  // `HB_SCRIPT_TIBETAN` (`hb-ot-shaper.hh:276`) falls through to the same USE
  // return as Sinhala. Listing it excluded exactly the scripts USE's
  // `NO_SHORT_CIRCUIT` normalization decomposes — i.e. the case the base+mark
  // rerouting hook exists to serve — and made `resolveDottedCircleHbRun` bail.
  // Unlike Sinhala/the DM-2033/DM-2054 additions above and below, Tibetan's
  // `isShapingRequired` gap has not been measured, so it stays out for now.
  [0x1000, 0x109F], // Myanmar
  [0x1780, 0x17FF], [0x19E0, 0x19FF], // Khmer
  [0x1100, 0x11FF], [0x3130, 0x318F], [0xA960, 0xA97F], [0xAC00, 0xD7FF], // Hangul (Jamo / Compat / Ext-B / Syllables)
  [0xAA60, 0xAA7F], [0xA9E0, 0xA9FF], [0x116D0, 0x116FF], // Myanmar Extended A/B/C
  [0xFB1D, 0xFB4F], [0xFB50, 0xFDFF], [0xFE70, 0xFEFF], // Hebrew/Arabic presentation forms

  // DM-2033: the "Arabic-misrouted" set — fontkit's own internal shaper
  // dispatch sends these to its `ArabicShaper` (a generic RTL-joining
  // approximation), but HarfBuzz's real dispatch sends all of them to USE
  // (`hb-ot-shaper.hh:300-301,322,336,339,414`, checked against the block list
  // at `:275-414`). Measured fontkit-vs-harfbuzzjs on each script's real darwin
  // production face (Noto Sans NKo / Mandaic / PhagsPa / Manichaean /
  // PsaPahlavi), explicit RTL direction where the script is RTL
  // (`isRtlScriptCodepoint`), one connected word plus one mark/tone-mark
  // sample per script: all AGREED byte-for-byte. As with Sinhala, this entry's
  // effect today is enabling `isShapingRequired`'s whole-run branch, not a
  // `HARFBUZZ_SHAPED_RANGES` reroute — nothing measured diverges (yet; only a
  // handful of samples per script were checked, not an exhaustive sweep).
  //
  // Mongolian is DELIBERATELY NOT included even though HarfBuzz also sends it
  // to USE (`hb-ot-shaper.hh:279`) and fontkit's own dispatch would misroute
  // it the same way in principle: on darwin its routing key
  // (`u-noto-sans-mongolian`) is `extractor: "native"`, so it is ALREADY
  // shaped by the CoreText helper today, never by fontkit — the bug this
  // section fixes (fontkit's wrong internal dispatch) cannot occur for a
  // script fontkit never shapes. Whether Mongolian's OWN `isShapingRequired`
  // gap (a native-extractor font still only gets per-character `.layout(ch)`
  // calls today, one glyph at a time, when not listed here) is worth closing
  // is unmeasured and out of scope for this pair of tickets.
  [0x07C0, 0x07FF], // N'Ko
  [0x0840, 0x085F], // Mandaic
  [0xA840, 0xA87F], // Phags-pa
  [0x10AC0, 0x10AFF], // Manichaean
  [0x10B80, 0x10BAF], // Psalter Pahlavi

  // DM-2054: SMP scripts HarfBuzz dispatches to USE
  // (`hb-ot-shaper.hh:294,300...414` for Kharoshthi;
  // `:348,361,364-365,414` for Adlam / Hanifi Rohingya / Old(+)Sogdian) that
  // had no `DEDICATED_SHAPER_RANGES` entry at all, found while validating an
  // unrelated bidi-js fix: even after that fix, a constructed
  // `A` + Adlam letters + `B` probe rendered byte-identical SVG markup
  // before/after, because these scripts never reached the shaping branch the
  // bidi levels feed into.
  //
  // Adlam and Hanifi Rohingya are ALSO in `HARFBUZZ_SHAPED_RANGES` below —
  // unlike every other script in this section, fontkit's `ArabicShaper`
  // measurably picks the WRONG glyphs for them (not just a cluster-map or
  // advance nuance — disjoint glyph-id sets from HarfBuzz's on the same font
  // file), so shaping through this list alone is not enough; see that entry.
  //
  // Kharoshthi is `extractor: "native"` on darwin (`u-noto-sans-kharoshthi`,
  // routed through the CoreText helper because fontkit's Noto Sans Indic
  // parser crashes on some of its GSUB — DM-983) but that only changes WHICH
  // engine's `.layout()` gets called, not whether `isShapingRequired` needs to
  // be true for a whole segment to reach it in one call instead of
  // one-character-at-a-time; measured fontkit(-proxy)-vs-harfbuzzjs agreement
  // on the block's real face over a plain letter sequence and a
  // vowel-sign-first edge case, both agreed.
  //
  // Old Sogdian, Sogdian and Old Uyghur are DELIBERATELY HELD OUT: probed live
  // (Playwright + CDP `CSS.getPlatformFontsForNode`) against this darwin
  // checkout, Chrome itself falls back to Times for all three (no system font
  // covers them — the darwin routing table's own guess, Arial Unicode MS, has
  // ZERO glyphs in any of the three blocks, checked with fontkit directly).
  // Routing them through whole-run shaping would be provably inert on macOS
  // today (no face to shape with, on either side), but adding an entry for a
  // script with no verified covering face anywhere is exactly the "routing to
  // tofu" the per-script check exists to catch, so they stay out until a real
  // covering face is confirmed on a calibrated platform.
  [0x1E900, 0x1E95F], // Adlam
  [0x10A00, 0x10A5F], // Kharoshthi
  [0x10D00, 0x10D3F], // Hanifi Rohingya
];
export function usesDedicatedShaper(cp: number): boolean {
  for (const [lo, hi] of DEDICATED_SHAPER_RANGES) {
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

// The subset of the dedicated-shaper blocks whose SHAPING is routed to HarfBuzz
// — the engine Chrome runs — instead of the platform shaper. The outlines are
// NOT routed with it: both application sites build the override with
// `outlinesFromBase: true`, so HarfBuzz supplies ids / positions / clusters and
// the platform engine still draws. Keeping those two apart is the whole reason
// this can be done at all; see the note on `harfbuzzShapedScriptOverride` in
// `font-resolution.ts` for the measurement that established it.
//
// The routing applies at TWO sites, and both are needed: per codepoint inside
// `resolveFontForCodepoint` (`harfbuzzShapedScriptOverride` — reaches every
// decision the legacy walk and the shaped splitter's system stage make), and
// per assembled run in the shaped splitter (`harfbuzzShapedRunOverride`,
// applied by `splitShapedInner` in `cluster-fallback.ts`) — because the
// splitter's primary and declared-family stages never call the resolver, so
// without the run-level site every entry here was inert whenever the primary
// or a declared family covered the script.
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

  // Myanmar + its three Extended blocks, and Khmer + Khmer Symbols. Unlike the
  // six entries above, the measurement behind these two is fontkit-vs-HarfBuzz,
  // not CoreText-vs-HarfBuzz — because on macOS, `unicode-font-routing.darwin.
  // generated.ts` routes the Myanmar and Khmer BASE blocks to "Myanmar Sangam
  // MN" / "Khmer Sangam MN", neither of which is `extractor: "native"`, so
  // these scripts are shaped by fontkit today, not the CoreText helper.
  // fontkit's own dispatch table sends `khmr` to `IndicShaper` and has NO entry
  // at all for `mymr` (falls through to `DefaultShaper`) — vs. HarfBuzz's real
  // dedicated Myanmar/Khmer Ragel shapers (`hb-ot-shaper-myanmar.cc`,
  // `hb-ot-shaper-khmer.cc`, rev 4de187d) — so the mechanism is wrong by
  // construction even though, measured against the specific system fonts these
  // blocks resolve to on this host, the observable output currently agrees:
  // representative samples (Khmer coeng clusters — ខ្ញុំ, កម្ពុជា, an orphaned
  // coeng+consonant with no base; Myanmar medial-ra/e-vowel reordering —
  // ကြော, မြန်မာ, kinzi ငျ်္က, an out-of-order upper vowel sign before its
  // base) all returned IDENTICAL glyph ids and advances from fontkit and from
  // harfbuzzjs on Myanmar Sangam MN / Khmer Sangam MN — both fonts implement
  // their reordering through generic GSUB features a non-specialized shaper
  // still applies, so the wrong dispatch has no reachable glyph/advance
  // divergence on these faces today. Rerouted anyway, per the standing "font
  // goal is guaranteed parity with Chromium's mechanism, not less code" policy
  // — an approximation that currently scores well is still the defect — and
  // because the reroute is then provably a no-op for present output (measured
  // inert = zero regression risk), not a speculative one.
  [0x1000, 0x109F],                                             // Myanmar
  [0xAA60, 0xAA7F], [0xA9E0, 0xA9FF], [0x116D0, 0x116FF],        // Myanmar Extended A/B/C
  [0x1780, 0x17FF], [0x19E0, 0x19FF],                            // Khmer + Khmer Symbols

  // Bengali. UNLIKE Myanmar/Khmer above, this one is NOT measured inert:
  // fontkit's `IndicShaper` IS the shaper HarfBuzz's Indic group would also
  // pick for Bengali (`beng` is one of HarfBuzz's nine Indic-shaper scripts,
  // `hb-ot-shaper.hh:224-232`), so the shaper CHOICE was already right. What's
  // missing is a feature fontkit's reimplementation doesn't have at all: HarfBuzz's
  // vowel-constraint preprocessing (`_hb_preprocess_text_vowel_constraints`,
  // `hb-ot-shaper-vowel-constraints.cc:58-446`, rev 4de187d) inserts a dotted
  // circle MID-SEQUENCE, with a base present, before a dependent vowel sign
  // that Unicode's Bengali orthography rules disallow directly after that
  // base. Measured directly on the block's actual production face (Kohinoor
  // Bangla, via fontkit — the base Bengali block is not `extractor: "native"`
  // either): U+0985 BENGALI LETTER A + U+09BE BENGALI VOWEL SIGN AA shapes to
  // 2 glyphs [4, 18] under fontkit and 3 glyphs [4, 104, 18] under harfbuzzjs
  // — id 104 is the font's own U+25CC glyph, GPOS-inserted between the base
  // and the vowel sign. This is the concrete case the ticket investigation
  // named, and it is a real, visible glyph-COUNT divergence, not a cluster-map
  // nuance: Domotion previously never drew the circle.
  [0x0980, 0x09FF],                                              // Bengali

  // Adlam and Hanifi Rohingya (DM-2054). UNLIKE the rest of the DM-2033/DM-2054
  // `DEDICATED_SHAPER_RANGES` additions above, these two are NOT measured inert:
  // fontkit's `ArabicShaper` — the shaper fontkit's own internal dispatch table
  // picks for both scripts, not HarfBuzz's real USE dispatch
  // (`hb-ot-shaper.hh:348,361,414`) — selects DIFFERENT GLYPHS entirely, not
  // just a cluster-map or advance/offset nuance. Measured on the blocks' real
  // darwin production faces (Noto Sans Adlam, Noto Sans HanifiRohg), explicit
  // RTL direction on both engines (`isRtlScriptCodepoint` already covers both
  // blocks):
  //
  //     Adlam 𞤀𞤁𞤂𞤃 (4 capital letters):
  //       fontkit  70@626,0,0  66@816,0,0  18@636,0,0  1@715,0,0
  //       hb       71@819,0,0  69@816,0,0  21@636,0,0  3@715,0,0
  //
  // Same visual order (both reverse the RTL run the same way, and the advance
  // SEQUENCE is close), but the glyph id SETS are disjoint — {70,66,18,1}
  // against {71,69,21,3} — on the SAME on-disk font file, so id N denotes the
  // same outline under both engines: fontkit is drawing four glyphs HarfBuzz
  // never selects for this text. HanifiRohingya 𐴀𐴁𐴂 shows the same shape of
  // divergence (glyph ids AND advances differ: fontkit `19@446 15@433 13@532`
  // vs hb `22@459 16@401 14@488`). Both scripts have real Arabic-style
  // initial/medial/final/isolated joining forms in GSUB — plausibly why
  // fontkit's generic `ArabicShaper` engages at all — but picks the wrong ones
  // where HarfBuzz's USE-based joining picks correctly for Chrome's paint.
  //
  // A second sample per script (an Adlam tone-mark pair, a second Hanifi
  // Rohingya letter pair) also diverged or agreed consistently with the above,
  // and the N'Ko / Mandaic / Phags-pa / Manichaean / Psalter Pahlavi / Sinhala
  // / Kharoshthi entries above were checked the same way and did NOT diverge —
  // this is not "reroute everything DM-2033/DM-2054 touched", it is the two
  // scripts that measurably need it.
  [0x1E900, 0x1E95F], // Adlam
  [0x10D00, 0x10D3F], // Hanifi Rohingya
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
// wholesale like a pure Left matra.)
//
// DM-2020: the range table itself (`USE_LEFT_MATRA_RANGES`) is now GENERATED
// by decoding HarfBuzz's own compiled USE syllabic-category lookup table
// (`use-left-matra-ranges.generated.ts` — VPre ∪ VMPre, see that file for
// provenance) rather than hand-curated. The hand list this replaced was
// missing U+0F3F, U+1C34 and U+1C35 because its stated derivation (UCD
// IndicPositionalCategory "Left" ∩ IndicSyllabicCategory=Vowel_Dependent)
// never named the VMPre category those three belong to; decoding HarfBuzz's
// table directly sidesteps re-deriving its own category-merge logic by hand
// a second time. Confirmed by the generator's self-check: all 97
// previously-committed members decode to VPre/VMPre with zero removals, and
// exactly the 3 members above are the only ones added.
export function isLeftReorderingMatra(cp: number): boolean {
  for (const [lo, hi] of USE_LEFT_MATRA_RANGES) {
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

// DM-1215 / DM-2019: right-to-left SMP scripts. When the synthetic dotted
// circle is inserted for an orphaned mark in one of these, Chrome paints the
// cell RTL — "mark ◌" (tofu LEFT, circle RIGHT) — not the LTR "◌ mark". The
// mark renders at the cell origin and the ◌ to its right, the same layout the
// pre-base left-matra branch uses. Inclusive [lo, hi]. (BMP RTL scripts —
// Hebrew / Arabic / Syriac / Thaana / Nko / Samaritan / Mandaic — keep the
// existing non-synthetic paths and are intentionally out of scope here.)
//
// Transcribed from HarfBuzz's `hb_script_get_horizontal_direction`
// (`hb-common.cc:522-613`, checked out at `external/harfbuzz`, rev 4de187d)
// rather than hand-curated: every `HB_DIRECTION_RTL` case whose Unicode block
// falls in the SMP. This is a straight port, not a sample — the earlier table
// was missing Cypriot, Imperial Aramaic, Palmyrene, Nabataean, Hatran,
// Phoenician, Lydian, Meroitic Hieroglyphs, Meroitic Cursive, Old South
// Arabian, Old North Arabian, Avestan, Inscriptional Parthian, Inscriptional
// Pahlavi, Psalter Pahlavi, and Old Turkic — all named in the ticket — PLUS
// Cypriot, Imperial Aramaic, and Rumi Numeral Symbols (Script=Arabic, a
// distinct block from the already-covered Arabic Extended-C), none of which
// the ticket's own prose list named. Those three were only caught by porting
// the FULL HarfBuzz switch and checking it against live Unicode Script data
// (`unicode-classification.test.ts`'s table-equality sweep) rather than
// against the ticket's list alone — evidence for doing the port rather than
// trusting a hand-written enumeration a second time.
//
// Deliberately NOT added: Old Hungarian. HarfBuzz's own switch returns
// `HB_DIRECTION_INVALID` for it (`hb-common.cc:604`, grouped with Old Italic /
// Runic / Tifinagh under "can be written either direction") — it is NOT
// unconditionally RTL. Adding it would have introduced a divergence from
// Chrome rather than fixed one.
//
// Verified inert for the current caller (`text-to-path.ts`'s orphaned-mark
// dotted-circle orientation check, which only ever passes a MARK codepoint):
// every newly-added script's assigned SMP range has ZERO combining-mark
// (`\p{M}`) codepoints, so this expansion cannot change any currently-emitted
// SVG. Kept anyway per the standing "guaranteed parity by construction, not
// less code" policy — a hand-curated approximation is the defect even where
// it currently scores clean — and to make `isRtlScriptCodepoint` a correct
// general predicate for whatever next reads it, not one narrowed to today's
// single call site.
//
// Also REMOVED two pre-existing entries the table-equality test caught:
// Indic Siyaq Numbers (U+1EC70-1ECBF) and Ottoman Siyaq Numbers
// (U+1ED00-1ED4F) are Script=Common, not Arabic — `hb_script_get_horizontal_
// direction` has no RTL (or INVALID) case for Common, so it falls through to
// the function's default `HB_DIRECTION_LTR`. DM-1215's commit message lists
// the scripts it actually verified against Chrome's painted output (Sogdian,
// Old Uyghur, Garay), and these two are not among them — they were added by
// grouping with the also-Arabic-adjacent "Arabic Mathematical Alphabetic
// Symbols" entry rather than checked. Also verified inert either way: like
// the additions above, both blocks have ZERO combining-mark codepoints, so
// this correction cannot change any currently-emitted SVG either.
const RTL_SMP_SCRIPT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x10800, 0x1083F], // Cypriot
  [0x10840, 0x1085F], // Imperial Aramaic
  [0x10860, 0x1087F], // Palmyrene
  [0x10880, 0x108AF], // Nabataean
  [0x108E0, 0x108FF], // Hatran
  [0x10900, 0x1091F], // Phoenician
  [0x10920, 0x1093F], // Lydian
  [0x10980, 0x1099F], // Meroitic Hieroglyphs
  [0x109A0, 0x109FF], // Meroitic Cursive
  [0x10A00, 0x10A5F], // Kharoshthi
  [0x10A60, 0x10A7F], // Old South Arabian
  [0x10A80, 0x10A9F], // Old North Arabian
  [0x10AC0, 0x10AFF], // Manichaean
  [0x10B00, 0x10B3F], // Avestan
  [0x10B40, 0x10B5F], // Inscriptional Parthian
  [0x10B60, 0x10B7F], // Inscriptional Pahlavi
  [0x10B80, 0x10BAF], // Psalter Pahlavi
  [0x10C00, 0x10C4F], // Old Turkic
  [0x10D00, 0x10D3F], // Hanifi Rohingya
  [0x10D40, 0x10D8F], // Garay
  [0x10E60, 0x10E7F], // Rumi Numeral Symbols (Script=Arabic)
  [0x10E80, 0x10EBF], // Yezidi
  [0x10EC0, 0x10EFF], // Arabic Extended-C
  [0x10F00, 0x10F2F], // Old Sogdian
  [0x10F30, 0x10F6F], // Sogdian
  [0x10F70, 0x10FAF], // Old Uyghur
  [0x10FB0, 0x10FDF], // Chorasmian
  [0x10FE0, 0x10FFF], // Elymaic
  [0x1E800, 0x1E8DF], // Mende Kikakui
  [0x1E900, 0x1E95F], // Adlam
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
// entirely (zero-width, no glyph) when the font lacks them. Unlike a
// genuinely-missing inkable glyph (which Chrome paints as a .notdef tofu),
// these paint NOTHING when uncovered. Our fallback chain otherwise routes an
// orphaned, uncovered one to the CoreText last-resort box, so each painted a
// tofu (the FE00-FE0F variation-selector fixture rendered a box per cell).
//
// DM-2020: widened from a hand-picked 3-range subset (variation selectors,
// variation selectors supplement, tags) to HarfBuzz's FULL default-ignorable
// table (`isHarfbuzzDefaultIgnorable`) — the hand subset missed soft hyphen,
// CGJ, U+061C, the Khmer inherent-vowel pair (U+17B4/17B5), the Mongolian
// FVS + vowel-separator block (U+180B-180E), most of the bidi/format-control
// block (only 200B-200F/202A-202E were ever consulted for THIS predicate's
// callers, and the range now correctly also carries 2060-206F and FEFF),
// U+FFF0-FFF8, and the musical-notation format controls (U+1D173-1D17A).
// Enumerated offline before this fix: 3,781 codepoints the narrow subset
// missed, the overwhelming majority in the unassigned tail of the tag
// supplement plane (U+E01F0-E0FFF) with the meaningful, reachable remainder
// exactly the ranges named above.
//
// ZWJ/ZWNJ (U+200C/200D) are explicitly carved back OUT even though
// HarfBuzz's table includes them (page 0x20's 200B-200F run) — deliberately
// narrower than a pure port, same as separators (spaces): both carry
// shaping/width meaning this function's caller must preserve, and stripping
// an orphaned joiner would be a no-op for shaping anyway (there is nothing
// for it to join without a base), so the carve-out changes nothing
// observable while keeping the predicate's stated contract explicit.
export function isStrippableOrphanIgnorable(cp: number): boolean {
  if (cp === 0x200C || cp === 0x200D) return false; // ZWNJ / ZWJ: shaping meaning
  return isHarfbuzzDefaultIgnorable(cp);
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

// ---------------------------------------------------------------------------
// text-decoration-skip-ink exclusions
// ---------------------------------------------------------------------------

/**
 * Codepoints Blink marks `is_cjk_ideograph_or_symbol` by explicit singleton.
 *
 * Transcribed verbatim from `kIsCjkIdeographOrSymbolArray`
 * (`third_party/blink/renderer/platform/text/character_property_data.h:17-36`,
 * Chromium rev `7d859f27`). Do not curate this — it is a table, and copying it
 * IS the parity answer. The first four entries are the Mandarin tone marks,
 * which is why the set starts well below the CJK blocks.
 */
const CJK_IDEOGRAPH_OR_SYMBOL_SINGLETONS = new Set<number>([
  0x2c7, 0x2ca, 0x2cb, 0x2d9, 0x2020, 0x2021, 0x2030, 0x203b, 0x203c, 0x2042,
  0x2047, 0x2048, 0x2049, 0x2051, 0x20dd, 0x20de, 0x2100, 0x2103, 0x2105,
  0x2109, 0x210a, 0x2113, 0x2116, 0x2121, 0x212b, 0x213b, 0x2150, 0x2151,
  0x2152, 0x217f, 0x2189, 0x2307, 0x2312, 0x23ce, 0x2423, 0x25a0, 0x25a1,
  0x25a2, 0x25aa, 0x25ab, 0x25b1, 0x25b2, 0x25b3, 0x25b6, 0x25b7, 0x25bc,
  0x25bd, 0x25c0, 0x25c1, 0x25c6, 0x25c7, 0x25c9, 0x25cb, 0x25cc, 0x25ef,
  0x2605, 0x2606, 0x260e, 0x2616, 0x2617, 0x26a0, 0x2713, 0x271a, 0x273f,
  0x2740, 0x2756, 0x2763, 0x2b1a, 0xfe10, 0xfe11, 0xfe12, 0xfe19, 0xff1d,
  // Emoji.
  0x1f100, 0x1f200, 0x1f237, 0x1f32c, 0x1f336, 0x1f37d, 0x1f43f, 0x1f54f,
  0x1f93b, 0x1f946,
]);

/**
 * Inclusive ranges Blink marks `is_cjk_ideograph_or_symbol`.
 *
 * Transcribed verbatim from `kIsCjkIdeographOrSymbolRanges`
 * (`character_property_data.h:40-108`, rev `7d859f27`), in source order so it
 * can be diffed against upstream. Blink's own comments are preserved where
 * they explain a boundary that would otherwise look arbitrary.
 */
const CJK_IDEOGRAPH_OR_SYMBOL_RANGES: ReadonlyArray<readonly [number, number]> = [
  // cjkIdeographRanges
  [0x2e80, 0x2fdf],   // CJK Radicals Supplement and Kangxi Radicals
  [0x31c0, 0x31ef],   // CJK Strokes
  [0x3400, 0x4dbf],   // CJK Unified Ideographs Extension A
  [0x4e00, 0x9fff],   // the basic CJK Unified Ideographs block
  [0xf900, 0xfaff],   // CJK Compatibility Ideographs
  [0x20000, 0x2ffff], // Supplementary Ideographic Plane (Ext B-F, Compat Suppl)

  // cjkSymbolRanges
  [0x2156, 0x215a], [0x2160, 0x216b], [0x2170, 0x217b], [0x23be, 0x23cc],
  [0x2460, 0x2492], [0x249c, 0x24ff], [0x25ce, 0x25d3], [0x25e2, 0x25e6],
  [0x2600, 0x2603], [0x2660, 0x266f],
  // Emoji heart-kiss sequence members, kept whole so the sequence is not split.
  [0x2672, 0x267d], [0x2776, 0x277f],
  // Ideographic Description Characters + CJK Symbols and Punctuation, stopping
  // short of the Hangul tone marks (U+302E-302F) because Hangul is not Han and
  // no other Hangul is included here; then Hiragana, Katakana and Bopomofo.
  [0x2ff0, 0x302d], [0x3031, 0x312f],
  [0x3190, 0x31bf],   // more Bopomofo, and Bopomofo Extended
  [0x3200, 0x33ff],   // Enclosed CJK Letters and Months + CJK Compatibility
  [0x4dc0, 0x4dff],   // Yijing Hexagram Symbols
  [0xf860, 0xf862],   // Apple's Japanese vendor mappings
  [0xfe30, 0xfe6f],   // CJK Compatibility Forms + Small Form Variants
  [0xff00, 0xff0c], [0xff0e, 0xff1a], [0xff1f, 0xffef], // Half/Fullwidth Forms
  [0x16fe0, 0x16fff], // Ideographic Symbols and Punctuation
  [0x17000, 0x187ff], // Tangut
  [0x18800, 0x18aff], // Tangut Components
  [0x1b000, 0x1b0ff], // Kana Supplement
  [0x1b100, 0x1b12f], // Kana Extended-A
  [0x1b170, 0x1b2ff], // Nushu
  // Emoji.
  [0x1f110, 0x1f129], [0x1f130, 0x1f149], [0x1f150, 0x1f169], [0x1f170, 0x1f189],
  [0x1f202, 0x1f219], [0x1f21b, 0x1f22e], [0x1f230, 0x1f231], [0x1f23b, 0x1f24f],
  [0x1f252, 0x1f2ff], [0x1f321, 0x1f32a], [0x1f394, 0x1f39f], [0x1f3cd, 0x1f3ce],
  [0x1f3d4, 0x1f3df], [0x1f3f1, 0x1f3f2], [0x1f3f5, 0x1f3f7], [0x1f4fd, 0x1f4fe],
  [0x1f53e, 0x1f54a], [0x1f568, 0x1f573], [0x1f576, 0x1f579], [0x1f57b, 0x1f58f],
  [0x1f591, 0x1f594], [0x1f597, 0x1f5a3], [0x1f5a5, 0x1f5e7], [0x1f5e9, 0x1f5fa],
  [0x1f650, 0x1f67f], [0x1f6c6, 0x1f6cb], [0x1f6cd, 0x1f6cf], [0x1f6d3, 0x1f6d4],
  [0x1f6d9, 0x1f6db], [0x1f6e0, 0x1f6ea], [0x1f6ed, 0x1f6f3], [0x1f6fd, 0x1f6ff],
  [0x1f900, 0x1f90b], [0x1fac9, 0x1facc],
];

/**
 * Mirrors `Character::IsCjkIdeographOrSymbol` (`character.h:97-100` →
 * `character.cc:101-103`, rev `7d859f27`).
 *
 * Blink reads this from a compile-time ICU trie whose contents come from three
 * places, all reproduced here: the two tables above, plus everything the
 * generator marks for emoji — `[:Emoji_Presentation:]` in full, and the
 * Extended_Pictographic members of RGI ZWJ / modifier sequences
 * (`character_property_data_generator.cc:117-141`).
 *
 * The `c < 0x2C7` early-out is Blink's own fast path, not an optimization
 * added here: it is what makes ASCII and Latin-1 unconditionally skip-inkable
 * regardless of the tables.
 *
 * KNOWN RESIDUAL, stated rather than papered over: the RGI-sequence clause is
 * not expressible in a JS regex, since ECMAScript exposes no RGI emoji-sequence
 * property. `\p{Emoji_Presentation}` is transcribed exactly; the remainder is
 * text-default pictographs that appear inside ZWJ sequences. Blink's own
 * tables already carry the ones that motivated the clause (the heart-kiss
 * members at U+2763 and U+2672-267D are singletons/ranges above), so the
 * residual is small — but it is a residual, and any codepoint in it will
 * skip ink here where Chrome does not.
 */
export function isCjkIdeographOrSymbol(cp: number): boolean {
  if (cp < 0x2c7) return false;
  if (CJK_IDEOGRAPH_OR_SYMBOL_SINGLETONS.has(cp)) return true;
  for (const [lo, hi] of CJK_IDEOGRAPH_OR_SYMBOL_RANGES) {
    if (cp >= lo && cp <= hi) return true;
  }
  return /\p{Emoji_Presentation}/u.test(String.fromCodePoint(cp));
}

/**
 * Unicode blocks Blink excludes from skip-ink beyond the CJK property, because
 * they are CJK-adjacent characters `IsCjkIdeographOrSymbol` does not cover —
 * the Hangul blocks and Linear B Ideograms
 * (`character.cc:153-165`, rev `7d859f27`).
 *
 * Expressed as the blocks' codepoint ranges because ECMAScript has no
 * `ublock_getCode` equivalent; the block boundaries are Unicode's and fixed.
 */
const SKIP_INK_EXCLUDED_BLOCKS: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x11ff],   // Hangul Jamo
  [0x3130, 0x318f],   // Hangul Compatibility Jamo
  [0xac00, 0xd7af],   // Hangul Syllables
  [0xa960, 0xa97f],   // Hangul Jamo Extended-A
  [0xd7b0, 0xd7ff],   // Hangul Jamo Extended-B
  [0x10080, 0x100ff], // Linear B Ideograms
];

/**
 * Mirrors `Character::CanTextDecorationSkipInk`
 * (`third_party/blink/renderer/platform/text/character.cc:143-167`,
 * Chromium rev `7d859f27`) — whether a decoration line may be interrupted by
 * this character's ink.
 *
 * Blink applies it PER CHARACTER while collecting intercepts
 * (`ShapeResultBloberizer::IsSkipInkException`,
 * `shaping/shape_result_bloberizer.cc:228-234`), not per run — so in mixed
 * text the Latin glyphs still produce gaps while the CJK ones beside them do
 * not. Callers must therefore test each glyph's own character, not the run.
 *
 * The `skip-ink: all` value would flip the CJK exclusion off
 * (`text_painter.cc:596-600`), but only behind the disabled-by-default
 * `CSSTextDecorationSkipInkAll` runtime flag, so `auto` semantics are what
 * ship and what this models.
 */
export function canTextDecorationSkipInk(cp: number): boolean {
  // SOLIDUS, REVERSE SOLIDUS, LOW LINE — glyphs that would be shredded by
  // their own descender-crossing strokes.
  if (cp === 0x002f || cp === 0x005c || cp === 0x005f) return false;
  if (isCjkIdeographOrSymbol(cp)) return false;
  for (const [lo, hi] of SKIP_INK_EXCLUDED_BLOCKS) {
    if (cp >= lo && cp <= hi) return false;
  }
  return true;
}
