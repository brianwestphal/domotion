#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const chromium = new URL("external/chromium/", root);
const header = readFileSync(new URL("third_party/blink/renderer/platform/text/character_property_data.h", chromium), "utf8");
const ucd = readFileSync(new URL("third_party/icu/source/data/unidata/ppucd.txt", chromium), "utf8");
const emojiSequences = readFileSync(new URL("third_party/icu/source/data/unidata/emoji-sequences.txt", chromium), "utf8");
const emojiZwjSequences = readFileSync(new URL("third_party/icu/source/data/unidata/emoji-zwj-sequences.txt", chromium), "utf8");

const MAX = 0x10ffff;
const selected = new Uint8Array(MAX + 1);
const emojiPresentation = new Uint8Array(MAX + 1);
const extendedPictographic = new Uint8Array(MAX + 1);

function mark(lo, hi = lo) {
  selected.fill(1, lo, hi + 1);
}

function parseHexValues(body) {
  const source = body.replace(/\/\/.*$/gm, "");
  return [...source.matchAll(/0x([0-9A-Fa-f]+)/g)].map((match) => Number.parseInt(match[1], 16));
}

const arrayBody = /kIsCjkIdeographOrSymbolArray\s*=\s*std::to_array<UChar32>\(\{([\s\S]*?)\}\);/.exec(header)?.[1];
const rangesBody = /kIsCjkIdeographOrSymbolRanges\s*=\s*std::to_array<UChar32>\(\{([\s\S]*?)\}\);/.exec(header)?.[1];
if (arrayBody == null || rangesBody == null) throw new Error("Blink CJK property tables not found");
for (const cp of parseHexValues(arrayBody)) mark(cp);
const rangeValues = parseHexValues(rangesBody);
if (rangeValues.length % 2 !== 0) throw new Error("Blink CJK range table has an odd endpoint count");
for (let i = 0; i < rangeValues.length; i += 2) mark(rangeValues[i], rangeValues[i + 1]);

function setProperty(target, lo, hi, fields, name, inherited) {
  let value = inherited;
  if (fields.includes(name)) value = true;
  if (fields.includes(`-${name}`)) value = false;
  target.fill(value ? 1 : 0, lo, hi + 1);
  return value;
}

// ppucd block records carry inherited defaults; following cp records override
// individual properties with EPres/ExtPict or -EPres/-ExtPict.
for (const raw of ucd.split(/\r?\n/)) {
  if (raw.startsWith("block;")) {
    const fields = raw.split(";");
    const [loText, hiText] = fields[1].split("..");
    const lo = Number.parseInt(loText, 16);
    const hi = Number.parseInt(hiText ?? loText, 16);
    setProperty(emojiPresentation, lo, hi, fields, "EPres", false);
    setProperty(extendedPictographic, lo, hi, fields, "ExtPict", false);
  } else if (raw.startsWith("cp;")) {
    const fields = raw.split(";");
    const cp = Number.parseInt(fields[1], 16);
    setProperty(emojiPresentation, cp, cp, fields, "EPres", emojiPresentation[cp] === 1);
    setProperty(extendedPictographic, cp, cp, fields, "ExtPict", extendedPictographic[cp] === 1);
  }
}
for (let cp = 0; cp <= MAX; cp++) if (emojiPresentation[cp] === 1) mark(cp);

function markSequenceMembers(text, wantedType) {
  for (const raw of text.split(/\r?\n/)) {
    const data = raw.split("#", 1)[0].trim();
    if (data === "") continue;
    const [codepoints, type] = data.split(";").map((part) => part.trim());
    if (type !== wantedType) continue;
    for (const token of codepoints.split(/\s+/)) {
      const cp = Number.parseInt(token, 16);
      if (extendedPictographic[cp] === 1) mark(cp);
    }
  }
}
markSequenceMembers(emojiZwjSequences, "RGI_Emoji_ZWJ_Sequence");
markSequenceMembers(emojiSequences, "RGI_Emoji_Modifier_Sequence");

const ranges = [];
let memberCount = 0;
for (let cp = 0; cp <= MAX; cp++) {
  if (selected[cp] === 0) continue;
  memberCount++;
  const last = ranges.at(-1);
  if (last != null && last[1] === cp - 1) last[1] = cp;
  else ranges.push([cp, cp]);
}
const packed = Buffer.allocUnsafe(ranges.length * 8);
ranges.forEach(([lo, hi], index) => {
  packed.writeUInt32LE(lo, index * 8);
  packed.writeUInt32LE(hi, index * 8 + 4);
});
const digest = createHash("sha256").update(packed).digest("hex");
const hex = (value) => `0x${value.toString(16).toUpperCase()}`;
const lines = ranges.map(([lo, hi]) => `  [${hex(lo)}, ${hex(hi)}],`);
const output = `// GENERATED FILE -- do not hand-edit. Regenerate with:
//   node tools/generate-cjk-ideograph-or-symbol-ranges.mjs
//
// Exact union produced by Blink's character_property_data_generator at
// Chromium 7d859f271cbda744098ac69f44978d4edfa62be3: its base CJK tables,
// pinned ICU 17 Emoji_Presentation, and Extended_Pictographic members of RGI
// emoji ZWJ/modifier sequences. Range endpoints are packed little-endian u32
// before hashing.
export const CJK_IDEOGRAPH_OR_SYMBOL_MEMBER_COUNT = ${memberCount};
export const CJK_IDEOGRAPH_OR_SYMBOL_SHA256 = "${digest}";
export const CJK_IDEOGRAPH_OR_SYMBOL_RANGES: ReadonlyArray<readonly [number, number]> = [
${lines.join("\n")}
];
`;
const target = new URL("src/render/cjk-ideograph-or-symbol-ranges.generated.ts", root);
if (process.argv.includes("--check")) {
  if (readFileSync(target, "utf8") !== output) {
    throw new Error("cjk-ideograph-or-symbol-ranges.generated.ts is stale; regenerate it");
  }
  console.error(`Verified ${ranges.length} ranges / ${memberCount} members / ${digest}`);
  process.exit(0);
}
writeFileSync(target, output);
console.error(`Wrote ${ranges.length} ranges / ${memberCount} members / ${digest}`);
