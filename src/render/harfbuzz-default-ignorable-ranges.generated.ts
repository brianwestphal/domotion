// GENERATED FILE -- do not hand-edit. Regenerate with:
//   node tools/generate-harfbuzz-default-ignorable-ranges.mjs
//
// The exact codepoint set HarfBuzz's `hb_unicode_funcs_t::is_default_ignorable`
// flags default-ignorable (`UPROPS_MASK_IGNORABLE`) -- what
// `hb_ot_hide_default_ignorables` / `hb_ot_zero_width_default_ignorables`
// (`hb-ot-shape.cc`) hide the ink and zero the advance of after shaping.
// Transcribed verbatim from `hb-unicode.hh:167-198` (checked out at
// `external/harfbuzz`, rev 4de187d) by
// `tools/generate-harfbuzz-default-ignorable-ranges.mjs`. Deliberately NOT
// the Unicode `Cf` general category or `Default_Ignorable_Code_Point`
// property -- both are broader than what HarfBuzz actually hides (e.g.
// U+06DD ARABIC END OF AYAH is `Cf` and carries a real, visible glyph; this
// table correctly excludes it, matching HarfBuzz).
//
// Consumed by `isLegitimatelyInklessCodepoint` and `isStrippableOrphanIgnorable`
// in `src/render/unicode-classification.ts`.
export const HARFBUZZ_DEFAULT_IGNORABLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0xAD, 0xAD],
  [0x34F, 0x34F],
  [0x61C, 0x61C],
  [0x17B4, 0x17B5],
  [0x180B, 0x180E],
  [0x200B, 0x200F],
  [0x202A, 0x202E],
  [0x2060, 0x206F],
  [0xFE00, 0xFE0F],
  [0xFEFF, 0xFEFF],
  [0xFFF0, 0xFFF8],
  [0x1D173, 0x1D17A],
  [0xE0000, 0xE0FFF],
];
