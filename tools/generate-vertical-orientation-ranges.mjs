#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const source = new URL("external/chromium/third_party/icu/source/data/unidata/ppucd.txt", root);
const text = readFileSync(source, "utf8");
const upright = new Uint8Array(0x110000); // ppucd default vo=R

const valueFor = (fields, inherited) => {
  const field = fields.find((part) => part.startsWith("vo="));
  return field == null ? inherited : field !== "vo=R";
};
for (const raw of text.split(/\r?\n/)) {
  const fields = raw.split(";");
  if (fields[0] === "block" || fields[0] === "unassigned") {
    const [loText, hiText] = fields[1].split("..");
    const lo = Number.parseInt(loText, 16);
    const hi = Number.parseInt(hiText ?? loText, 16);
    upright.fill(valueFor(fields, false) ? 1 : 0, lo, hi + 1);
  } else if (fields[0] === "cp") {
    const cp = Number.parseInt(fields[1], 16);
    upright[cp] = valueFor(fields, upright[cp] === 1) ? 1 : 0;
  }
}

const ranges = [];
let memberCount = 0;
for (let cp = 0; cp <= 0x10ffff; cp++) {
  if (upright[cp] === 0) continue;
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
const output = `// GENERATED FILE -- do not hand-edit. Regenerate with:
//   node tools/generate-vertical-orientation-ranges.mjs
//
// Chromium-pinned ICU 17 Vertical_Orientation values as Blink consumes them:
// U, Tu, and Tr are upright in mixed vertical text; only R is rotated.
export const MIXED_VERTICAL_UPRIGHT_MEMBER_COUNT = ${memberCount};
export const MIXED_VERTICAL_UPRIGHT_SHA256 = "${digest}";
export const MIXED_VERTICAL_UPRIGHT_RANGES = [
${ranges.map(([lo, hi]) => `  [${hex(lo)}, ${hex(hi)}],`).join("\n")}
];
`;
const target = new URL("src/capture/script/vertical-orientation.generated.ts", root);
if (process.argv.includes("--check")) {
  if (readFileSync(target, "utf8") !== output) throw new Error("vertical-orientation.generated.ts is stale");
  console.error(`Verified ${ranges.length} ranges / ${memberCount} members / ${digest}`);
} else {
  writeFileSync(target, output);
  console.error(`Wrote ${ranges.length} ranges / ${memberCount} members / ${digest}`);
}
