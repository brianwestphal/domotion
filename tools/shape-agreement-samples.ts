/**
 * The sample corpus for `tools/shape-agreement.ts`.
 *
 * Every entry is chosen because it EXERCISES a shaping decision — a
 * substitution, a reordering, or a mark placement that a shaper can get wrong
 * while still producing plausible output. Text that only maps codepoints to
 * glyphs one-for-one cannot discriminate between two shapers and is therefore
 * near-useless here, which rules out most Latin.
 *
 * The two Latin entries are the exception and are deliberate: they are the
 * control arm. If a run reports disagreements on `fi`/`VAV` but nowhere else,
 * the finding is about kerning and ligature defaults, not about the complex
 * shapers — and if it reports them EVERYWHERE including these, the harness
 * itself is comparing the wrong units.
 *
 * Coverage is per-face: the harness runs a sample against a face only when the
 * face covers every codepoint (see `covers`), so a Latin face contributes only
 * the Latin entries and GeezaPro only the Arabic ones. That is why this list is
 * flat rather than keyed by face — the coverage check does the routing, and it
 * does it from the font's actual cmap rather than from an assumption about
 * which face "is" the Arabic one.
 */
export interface ShapeSample {
  /** Script or feature under test — grouped in the summary output. */
  script: string;
  text: string;
  /** What a shaper has to get RIGHT here. Not decoration: this is the reason
   *  the entry earns its place, and the thing to read when it fails. */
  note: string;
}

export const SHAPE_SAMPLES: ShapeSample[] = [
  // --- Control arm -------------------------------------------------------
  { script: "latin", text: "fi fl ffi", note: "standard ligature substitution (liga)" },
  { script: "latin", text: "VAV To Wa", note: "pair kerning — GPOS or the legacy kern table" },

  // --- Arabic: contextual joining, the classic four-form problem ----------
  // A shaper that skips joining still emits one plausible glyph per letter, so
  // this is exactly the failure that hides from "did it produce output?".
  { script: "arabic", text: "مرحبا", note: "marhaba — init/medi/fina forms" },
  { script: "arabic", text: "لا", note: "lam-alef mandatory ligature" },
  { script: "arabic", text: "بِسْمِ", note: "kasra/sukun mark placement over joined bases" },
  { script: "arabic", text: "العربية", note: "al-arabiyya — definite article plus joining" },

  // --- Hebrew: right-to-left with below-base points -----------------------
  { script: "hebrew", text: "שלום", note: "shalom — RTL ordering, no joining" },
  { script: "hebrew", text: "בְּרֵאשִׁ", note: "niqqud + shin dot — stacked mark placement" },

  // --- Devanagari: reordering, the hardest thing in the Indic shaper ------
  { script: "devanagari", text: "क्ष", note: "ksha conjunct — virama ligature" },
  { script: "devanagari", text: "हिन्दी", note: "hindi — i-matra reorders BEFORE its base" },
  { script: "devanagari", text: "र्क", note: "reph — ra+virama moves to the end of the cluster" },
  { script: "devanagari", text: "कि", note: "single i-matra, isolated: pure reordering, no conjunct" },

  // --- Bengali / Tamil / Telugu: the same machine, different rules --------
  { script: "bengali", text: "ক্ষ", note: "khanda conjunct" },
  { script: "tamil", text: "க்கு", note: "virama + u-matra" },
  { script: "telugu", text: "క్ష", note: "below-base consonant stacking" },

  // --- Thai: no spaces, marks above and below a base ----------------------
  { script: "thai", text: "สวัสดี", note: "sawasdee — vowel above, tone mark stacking" },
  { script: "thai", text: "ปื้น", note: "sara-uee plus tone — two marks over one base" },

  // --- Khmer / Myanmar / Lao: further reordering shapers ------------------
  { script: "khmer", text: "ខ្ញុំ", note: "coeng subscript plus vowel" },
  { script: "myanmar", text: "ကြော", note: "medial ra and e-vowel prescript reordering" },
  { script: "lao", text: "ລາວ", note: "Lao vowel placement" },

  // --- Hangul: jamo composition -------------------------------------------
  { script: "hangul", text: "한글", note: "decomposed jamo — must compose to syllable blocks" },
  { script: "hangul", text: "한글", note: "precomposed syllables — must NOT decompose" },

  // --- CJK: GPOS punctuation compression ----------------------------------
  { script: "cjk", text: "漢字。「文」", note: "halfwidth punctuation positioning (GPOS palt/vpal)" },

  // --- Combining marks on Latin: NFD vs precomposed ------------------------
  // The Kaithi/Balinese class of bug in miniature: does the shaper compose, or
  // place the mark from its own outline?
  { script: "combining", text: "é ä ô", note: "decomposed accents — compose or GPOS-place" },
  { script: "combining", text: "é ä ô", note: "precomposed accents — the same word, other spelling" },

  // --- Coverage dimensions required by the exact oracle -----------------
  { script: "emoji", text: "👩🏽‍💻", note: "ZWJ sequence plus skin-tone modifier" },
  { script: "emoji", text: "✈︎ ✈️", note: "VS15/VS16 presentation distinction" },
  { script: "bidi", text: "A⁧אב⁩B", note: "RTL isolate with UTF-16 source ownership" },
  { script: "bidi", text: "A‮12‬B", note: "explicit RTL override and PDF control" },
  { script: "cjk", text: "（縦書き）", note: "vertical-form substitutions when shaped TTB" },
  { script: "variable", text: "Hamburgefonts", note: "variation-axis advances and substitutions" },
];
