#!/usr/bin/env node
// Generates packages/text-engine/src/render/use-left-matra-ranges.generated.ts: the codepoints
// HarfBuzz's Universal Shaping Engine reorders to BEFORE their base — the
// USE syllabic-category "VPre" (22) and "VMPre" (23) members.
//
// This regenerates DM-1109's `LEFT_REORDER_MATRA_RANGES`
// (`packages/text-engine/src/render/unicode-classification.ts`) from HarfBuzz's own compiled
// table instead of the hand-curated list it started as: the stated
// derivation ("intersection of IndicPositionalCategory Left placements with
// IndicSyllabicCategory=Vowel_Dependent") never named the VMPre category, so
// the hand list was missing every VMPre-only codepoint (U+0F3F, U+1C34,
// U+1C35 — verified below by decoding HarfBuzz's own table rather than
// re-deriving the UCD intersection by hand a second time).
//
// Rather than re-deriving from the raw UCD files (IndicSyllabicCategory.txt
// / IndicPositionalCategory.txt) and risking a second hand-rederivation of
// HarfBuzz's own merge logic, this PARSES HarfBuzz's already-generated,
// already-shipped decision table directly out of the checked-out source:
// `external/harfbuzz/src/hb-ot-shaper-use-table.hh` (the `#ifndef
// HB_OPTIMIZE_SIZE` variant — the one a non-size-optimized HarfBuzz build,
// what Chromium ships, actually compiles) and `hb-ot-shaper-use-machine.hh`
// (the `use_syllable_machine_ex_*` category-name → numeric-id defines the
// table's array literals reference by macro name, e.g. `VPre`, `MPre`).
//
// The packed-array decode formula (`hb_use_get_category`, the `hb_use_b4`
// nibble helper, and the offsets 113 / 625 / 2953 baked into the two-level
// nested lookup) is transcribed verbatim from
// `hb-ot-shaper-use-table.hh:378-383` (checked out at `external/harfbuzz`,
// rev 4de187d) — HarfBuzz's own "packtab" codegen scheme, not
// reverse-engineered from scratch. Those offsets are specific to the exact
// array sizes in that revision's table; a future HarfBuzz revision that
// resizes the table changes this formula too, which is exactly what the
// self-check below exists to catch rather than silently emitting a wrong
// table.
//
// Self-check: before writing anything, this script requires that decoding
// every currently-committed `LEFT_REORDER_MATRA_RANGES` member agrees
// (VPre or VMPre) for ALL of them. A decode bug that silently produced a
// wrong table would very likely disagree with at least one of the 97
// already-verified-against-Chrome members.
//
// Regenerate with: node tools/generate-use-left-matra-ranges.mjs
import { readFileSync, writeFileSync } from "node:fs";

const HARFBUZZ_REV = "4de187d"; // external/harfbuzz HEAD as of writing (git -C external/harfbuzz log -1)
const harfbuzzDir = new URL("../external/harfbuzz/src/", import.meta.url);

const tableSrc = readFileSync(new URL("hb-ot-shaper-use-table.hh", harfbuzzDir), "utf-8");
const machineSrc = readFileSync(new URL("hb-ot-shaper-use-machine.hh", harfbuzzDir), "utf-8");

// Category name -> numeric id, from `#define use_syllable_machine_ex_NAME NNu`.
const catByName = new Map();
for (const m of machineSrc.matchAll(/^#define use_syllable_machine_ex_(\w+)\s+(\d+)u\s*$/gm)) {
  catByName.set(m[1], parseInt(m[2], 10));
}
if (catByName.size === 0)
  throw new Error("no use_syllable_machine_ex_* defines found -- hb-ot-shaper-use-machine.hh format changed?");
const VPre = catByName.get("VPre");
const VMPre = catByName.get("VMPre");
const O = catByName.get("O");
if (VPre == null || VMPre == null || O == null) throw new Error("VPre/VMPre/O category ids not found");
console.error(`VPre=${VPre} VMPre=${VMPre} O=${O} (hb-ot-shaper-use-machine.hh, rev ${HARFBUZZ_REV})`);

// Pull the FIRST (`#ifndef HB_OPTIMIZE_SIZE`) hb_use_u8 / hb_use_u16 array
// bodies -- the variant a non-size-optimized HarfBuzz build compiles.
function firstArrayBody(name, type) {
  const re = new RegExp(`static const ${type} ${name}\\[\\d+\\]=\\s*\\{([\\s\\S]*?)\\};`);
  const m = re.exec(tableSrc);
  if (m == null) throw new Error(`array ${name} not found in hb-ot-shaper-use-table.hh`);
  return m[1];
}
function parseNums(body) {
  return body
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((t) => {
      if (/^\d+$/.test(t)) return parseInt(t, 10);
      const v = catByName.get(t);
      if (v == null) throw new Error(`unrecognized table token "${t}"`);
      return v;
    });
}
const u8 = parseNums(firstArrayBody("hb_use_u8", "uint8_t"));
const u16 = parseNums(firstArrayBody("hb_use_u16", "uint16_t"));
console.error(`hb_use_u8: ${u8.length} entries, hb_use_u16: ${u16.length} entries`);
if (u8.length !== 3343)
  throw new Error(
    `expected hb_use_u8[3343], got ${u8.length} -- table resized, re-verify the formula/offsets before trusting output`,
  );
if (u16.length !== 864)
  throw new Error(
    `expected hb_use_u16[864], got ${u16.length} -- table resized, re-verify the formula/offsets before trusting output`,
  );

// Transcribed verbatim from hb-ot-shaper-use-table.hh:376-383 (rev 4de187d).
function hbUseB4(a, i) {
  return (a[i >> 1] >> ((i & 1) << 2)) & 15;
}
function hbUseGetCategory(u) {
  if (u >= 921600) return O;
  const d = hbUseB4(u8, u >>> 12);
  const idx1 = 113 + (d << 5) + ((u >>> 7) & 31);
  const v1 = u8[idx1];
  const idx2 = (v1 << 3) + ((u >>> 4) & 7);
  const v2 = u16[idx2];
  const idx3 = 625 + v2 + ((u >>> 1) & 7);
  const v3 = u8[idx3];
  const idx4 = 2953 + (v3 << 1) + (u & 1);
  return u8[idx4];
}

// Self-check against the PRE-DM-2020 hand-curated `LEFT_REORDER_MATRA_RANGES`
// table that used to live in `unicode-classification.ts` — frozen here rather
// than read live, because that file now imports FROM this generator's output
// (reading it back would be circular, not a corroboration). This was the
// table DM-1109 and its follow-ups verified against Chrome's painted output
// member-by-member; every one of its 97 codepoints decoding to VPre/VMPre
// here is the load-bearing check that the packed-table decode above is
// correct, not merely plausible-looking.
const PRE_DM2020_KNOWN_GOOD_RANGES = [
  [0x93f, 0x93f],
  [0x94e, 0x94e],
  [0x9bf, 0x9bf],
  [0x9c7, 0x9c8],
  [0x9cb, 0x9cc],
  [0xa3f, 0xa3f],
  [0xabf, 0xabf],
  [0xb47, 0xb48],
  [0xb4b, 0xb4c],
  [0xbc6, 0xbc8],
  [0xbca, 0xbcc],
  [0xd46, 0xd48],
  [0xd4a, 0xd4c],
  [0xdd9, 0xdde],
  [0x1031, 0x1031],
  [0x1084, 0x1084],
  [0x17be, 0x17c5],
  [0x1a19, 0x1a19],
  [0x1a6e, 0x1a72],
  [0x1b3e, 0x1b41],
  [0x1ba6, 0x1ba6],
  [0x1c27, 0x1c29],
  [0xa9ba, 0xa9bb],
  [0xaa2f, 0xaa30],
  [0xaaeb, 0xaaeb],
  [0xaaee, 0xaaee],
  [0x110b1, 0x110b1],
  [0x1112c, 0x1112c],
  [0x111b4, 0x111b4],
  [0x111ce, 0x111ce],
  [0x112e1, 0x112e1],
  [0x11347, 0x11348],
  [0x1134b, 0x1134c],
  [0x113c2, 0x113c2],
  [0x113c5, 0x113c5],
  [0x113c7, 0x113c8],
  [0x11436, 0x11436],
  [0x114b1, 0x114b1],
  [0x114b9, 0x114b9],
  [0x114bb, 0x114bc],
  [0x114be, 0x114be],
  [0x115b0, 0x115b0],
  [0x115b8, 0x115bb],
  [0x116ae, 0x116ae],
  [0x11726, 0x11726],
  [0x1182d, 0x1182d],
  [0x11935, 0x11935],
  [0x11937, 0x11938],
  [0x119d2, 0x119d2],
  [0x119e4, 0x119e4],
  [0x11cb1, 0x11cb1],
  [0x11ef5, 0x11ef5],
  [0x11f3e, 0x11f3f],
];
const committedRanges = PRE_DM2020_KNOWN_GOOD_RANGES;
console.error(`Known-good (pre-DM-2020) ranges: ${committedRanges.length}`);

let selfCheckFailures = 0;
for (const [lo, hi] of committedRanges) {
  for (let cp = lo; cp <= hi; cp++) {
    const cat = hbUseGetCategory(cp);
    if (cat !== VPre && cat !== VMPre) {
      console.error(
        `SELF-CHECK FAILED: committed member U+${cp.toString(16).toUpperCase()} decodes to category ${cat}, not VPre/VMPre`,
      );
      selfCheckFailures++;
    }
  }
}
if (selfCheckFailures > 0) {
  throw new Error(
    `${selfCheckFailures} committed LEFT_REORDER_MATRA_RANGES member(s) disagree with the decoder -- refusing to write a table built on an unverified decode. Re-check the transcribed formula/offsets against hb-ot-shaper-use-table.hh before retrying.`,
  );
}
console.error("Self-check passed: every committed member decodes to VPre/VMPre.");

// Full sweep: every assigned-plane codepoint (0..0x10FFFF, skipping
// surrogates) whose USE category is VPre or VMPre.
const members = [];
for (let cp = 0; cp <= 0x10ffff; cp++) {
  if (cp >= 0xd800 && cp <= 0xdfff) continue;
  const cat = hbUseGetCategory(cp);
  if (cat === VPre || cat === VMPre) members.push(cp);
}
console.error(`Full sweep: ${members.length} VPre/VMPre codepoints`);

// Collapse into contiguous ranges.
const ranges = [];
for (const cp of members) {
  const last = ranges[ranges.length - 1];
  if (last != null && last[1] === cp - 1) last[1] = cp;
  else ranges.push([cp, cp]);
}
console.error(`Collapsed into ${ranges.length} ranges`);

// Diff against the committed table for the generation log (informational).
const committedSet = new Set();
for (const [lo, hi] of committedRanges) for (let cp = lo; cp <= hi; cp++) committedSet.add(cp);
const generatedSet = new Set(members);
const added = [...generatedSet].filter((cp) => !committedSet.has(cp));
const removed = [...committedSet].filter((cp) => !generatedSet.has(cp));
console.error(
  `Added vs committed: ${added.length} — ${added.map((cp) => "U+" + cp.toString(16).toUpperCase()).join(", ")}`,
);
console.error(
  `Removed vs committed: ${removed.length} — ${removed.map((cp) => "U+" + cp.toString(16).toUpperCase()).join(", ")}`,
);

const hex = (n) => "0x" + n.toString(16).toUpperCase();
const lines = [];
for (let i = 0; i < ranges.length; i += 4) {
  const chunk = ranges.slice(i, i + 4).map(([lo, hi]) => `[${hex(lo)}, ${hex(hi)}]`);
  lines.push("  " + chunk.join(", ") + ",");
}

const banner = `// GENERATED FILE -- do not hand-edit. Regenerate with:
//   node tools/generate-use-left-matra-ranges.mjs
//
// The codepoints HarfBuzz's Universal Shaping Engine reorders to BEFORE
// their base — USE syllabic category VPre (${VPre}) or VMPre (${VMPre}) — decoded
// directly from HarfBuzz's own compiled lookup table
// (\`external/harfbuzz/src/hb-ot-shaper-use-table.hh\`, rev ${HARFBUZZ_REV}) by
// \`tools/generate-use-left-matra-ranges.mjs\`, which parses the table's C
// array literals and re-implements its \`hb_use_get_category\` packed-lookup
// formula verbatim (transcribed, not re-derived). See that script for the
// self-check gate and the full provenance.
//
// Consumed by \`isLeftReorderingMatra\` in \`packages/text-engine/src/render/unicode-classification.ts\`.
export const USE_LEFT_MATRA_RANGES: ReadonlyArray<readonly [number, number]> = [
${lines.join("\n")}
];
`;

writeFileSync(
  new URL("../packages/text-engine/src/render/use-left-matra-ranges.generated.ts", import.meta.url),
  banner,
);
console.error("Wrote packages/text-engine/src/render/use-left-matra-ranges.generated.ts");
