#!/usr/bin/env node
// Generates src/render/harfbuzz-default-ignorable-ranges.generated.ts: the
// exact codepoint set HarfBuzz's `hb_unicode_funcs_t::is_default_ignorable`
// flags as default-ignorable (`UPROPS_MASK_IGNORABLE`), which is what
// `hb_ot_hide_default_ignorables` / `hb_ot_zero_width_default_ignorables`
// (`hb-ot-shape.cc`) consult to hide a glyph's ink and zero its advance
// after shaping.
//
// Transcribed verbatim from `hb-unicode.hh:167-198` (checked out at
// `external/harfbuzz`, rev 4de187d) rather than approximated from the
// Unicode `\p{Cf}` general category or the UCD `Default_Ignorable_Code_Point`
// property — HarfBuzz's set is neither. It is a NARROW, explicit table with
// documented carve-outs (U+115F/1160/3164/FFA0 are Default_Ignorable but
// Uniscribe-compatibility keeps them visible; U+1BCA0-1BCA3 are excluded
// too), and the general Unicode `Cf` (Format) category includes many
// codepoints — U+06DD ARABIC END OF AYAH among them — that carry a real,
// visible glyph in every font that supports the script and that HarfBuzz
// does NOT hide.
//
// Regenerate with: node tools/generate-harfbuzz-default-ignorable-ranges.mjs
import { writeFileSync } from "node:fs";

const HARFBUZZ_REV = "4de187d"; // external/harfbuzz HEAD as of writing (git -C external/harfbuzz log -1)

// Transcribed verbatim from hb-unicode.hh:167-198 (rev 4de187d).
function hbIsDefaultIgnorable(ch) {
  const plane = ch >>> 16;
  if (plane === 0) {
    const page = ch >>> 8;
    switch (page) {
      case 0x00: return ch === 0x00AD;
      case 0x03: return ch === 0x034F;
      case 0x06: return ch === 0x061C;
      case 0x17: return ch >= 0x17B4 && ch <= 0x17B5;
      case 0x18: return ch >= 0x180B && ch <= 0x180E;
      case 0x20: return (ch >= 0x200B && ch <= 0x200F) || (ch >= 0x202A && ch <= 0x202E) || (ch >= 0x2060 && ch <= 0x206F);
      case 0xFE: return (ch >= 0xFE00 && ch <= 0xFE0F) || ch === 0xFEFF;
      case 0xFF: return ch >= 0xFFF0 && ch <= 0xFFF8;
      default: return false;
    }
  } else {
    switch (plane) {
      case 0x01: return ch >= 0x1D173 && ch <= 0x1D17A;
      case 0x0E: return ch >= 0xE0000 && ch <= 0xE0FFF;
      default: return false;
    }
  }
}

const members = [];
for (let cp = 0; cp <= 0x10ffff; cp++) {
  if (hbIsDefaultIgnorable(cp)) members.push(cp);
}
console.error(`${members.length} default-ignorable codepoints`);

const ranges = [];
for (const cp of members) {
  const last = ranges[ranges.length - 1];
  if (last != null && last[1] === cp - 1) last[1] = cp;
  else ranges.push([cp, cp]);
}
console.error(`Collapsed into ${ranges.length} ranges`);

const hex = (n) => "0x" + n.toString(16).toUpperCase();
const lines = ranges.map(([lo, hi]) => `  [${hex(lo)}, ${hex(hi)}],`);

const banner = `// GENERATED FILE -- do not hand-edit. Regenerate with:
//   node tools/generate-harfbuzz-default-ignorable-ranges.mjs
//
// The exact codepoint set HarfBuzz's \`hb_unicode_funcs_t::is_default_ignorable\`
// flags default-ignorable (\`UPROPS_MASK_IGNORABLE\`) -- what
// \`hb_ot_hide_default_ignorables\` / \`hb_ot_zero_width_default_ignorables\`
// (\`hb-ot-shape.cc\`) hide the ink and zero the advance of after shaping.
// Transcribed verbatim from \`hb-unicode.hh:167-198\` (checked out at
// \`external/harfbuzz\`, rev ${HARFBUZZ_REV}) by
// \`tools/generate-harfbuzz-default-ignorable-ranges.mjs\`. Deliberately NOT
// the Unicode \`Cf\` general category or \`Default_Ignorable_Code_Point\`
// property -- both are broader than what HarfBuzz actually hides (e.g.
// U+06DD ARABIC END OF AYAH is \`Cf\` and carries a real, visible glyph; this
// table correctly excludes it, matching HarfBuzz).
//
// Consumed by \`isLegitimatelyInklessCodepoint\` and \`isStrippableOrphanIgnorable\`
// in \`src/render/unicode-classification.ts\`.
export const HARFBUZZ_DEFAULT_IGNORABLE_RANGES: ReadonlyArray<readonly [number, number]> = [
${lines.join("\n")}
];
`;

writeFileSync(new URL("../src/render/harfbuzz-default-ignorable-ranges.generated.ts", import.meta.url), banner);
console.error("Wrote src/render/harfbuzz-default-ignorable-ranges.generated.ts");
