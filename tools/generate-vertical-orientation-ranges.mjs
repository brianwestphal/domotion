#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const source = new URL("external/chromium/third_party/icu/source/data/unidata/ppucd.txt", root);
const text = readFileSync(source, "utf8");
const upright = new Uint8Array(0x110000); // ppucd default vo=R
const graphemeExtend = new Uint8Array(0x110000); // binary-property default=false

const verticalValueFor = (fields, inherited) => {
  const field = fields.find((part) => part.startsWith("vo="));
  return field == null ? inherited : field !== "vo=R";
};
const binaryValueFor = (fields, name, inherited) => {
  if (fields.includes(name)) return true;
  if (fields.includes(`-${name}`)) return false;
  return inherited;
};
for (const raw of text.split(/\r?\n/)) {
  const fields = raw.split(";");
  if (fields[0] === "block" || fields[0] === "unassigned") {
    const [loText, hiText] = fields[1].split("..");
    const lo = Number.parseInt(loText, 16);
    const hi = Number.parseInt(hiText ?? loText, 16);
    // ppucd block and unassigned rows both start from the file-wide defaults;
    // only `cp` rows inherit the containing block. In particular, the
    // noncharacters at the end of each PUA plane omit `vo=U` and therefore
    // remain rotated, while unassigned holes in a mark block are not
    // Grapheme_Extend unless their own row says so.
    upright.fill(verticalValueFor(fields, false) ? 1 : 0, lo, hi + 1);
    graphemeExtend.fill(binaryValueFor(fields, "Gr_Ext", false) ? 1 : 0, lo, hi + 1);
  } else if (fields[0] === "cp") {
    const cp = Number.parseInt(fields[1], 16);
    upright[cp] = verticalValueFor(fields, upright[cp] === 1) ? 1 : 0;
    graphemeExtend[cp] = binaryValueFor(fields, "Gr_Ext", graphemeExtend[cp] === 1) ? 1 : 0;
  }
}

const pack = (members) => {
  const ranges = [];
  let memberCount = 0;
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (members[cp] === 0) continue;
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
  return {
    ranges,
    memberCount,
    digest: createHash("sha256").update(packed).digest("hex"),
  };
};
const vertical = pack(upright);
const extend = pack(graphemeExtend);
const unicodeVersion = /^ucd;([^\r\n]+)$/m.exec(text)?.[1];
if (unicodeVersion == null) throw new Error("ppucd.txt has no UCD version");
const sourceDigest = createHash("sha256").update(text).digest("hex");
const hex = (value) => `0x${value.toString(16).toUpperCase()}`;
const output = `// GENERATED FILE -- do not hand-edit. Regenerate with:
//   node tools/generate-vertical-orientation-ranges.mjs
//
// Chromium-pinned ICU Vertical_Orientation and Grapheme_Extend properties as
// Blink's OrientationIterator consumes them. U, Tu, and Tr are upright in
// mixed vertical text; only R is rotated. Grapheme_Extend scalars inherit the
// current orientation after the first scalar in an iterator run.
export const VERTICAL_ORIENTATION_UNICODE_VERSION = "${unicodeVersion}";
export const VERTICAL_ORIENTATION_SOURCE_SHA256 = "${sourceDigest}";
export const MIXED_VERTICAL_UPRIGHT_MEMBER_COUNT = ${vertical.memberCount};
export const MIXED_VERTICAL_UPRIGHT_SHA256 = "${vertical.digest}";
export const MIXED_VERTICAL_UPRIGHT_RANGES = [
${vertical.ranges.map(([lo, hi]) => `  [${hex(lo)}, ${hex(hi)}],`).join("\n")}
];
export const GRAPHEME_EXTEND_MEMBER_COUNT = ${extend.memberCount};
export const GRAPHEME_EXTEND_SHA256 = "${extend.digest}";
export const GRAPHEME_EXTEND_RANGES = [
${extend.ranges.map(([lo, hi]) => `  [${hex(lo)}, ${hex(hi)}],`).join("\n")}
];
`;
const target = new URL("src/capture/script/vertical-orientation.generated.ts", root);
if (process.argv.includes("--check")) {
  if (readFileSync(target, "utf8") !== output) throw new Error("vertical-orientation.generated.ts is stale");
  console.error(`Verified vertical=${vertical.ranges.length}/${vertical.memberCount}/${vertical.digest} grapheme-extend=${extend.ranges.length}/${extend.memberCount}/${extend.digest}`);
} else {
  writeFileSync(target, output);
  console.error(`Wrote vertical=${vertical.ranges.length}/${vertical.memberCount}/${vertical.digest} grapheme-extend=${extend.ranges.length}/${extend.memberCount}/${extend.digest}`);
}
