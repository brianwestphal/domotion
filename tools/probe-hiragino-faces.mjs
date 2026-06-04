import * as fontkit from "fontkit";
import { readdirSync } from "node:fs";

// What faces live in the Hiragino files, and which covers the canonical Han of
// the 2F800 compat-ideograph block better?
const candidates = [
  "/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc",
  "/System/Library/Fonts/Hiragino Sans GB.ttc",
];
// list any other Hiragino files present
for (const f of readdirSync("/System/Library/Fonts")) {
  if (/ヒラギノ|Hiragino/i.test(f) && !candidates.some((c) => c.endsWith(f))) candidates.push(`/System/Library/Fonts/${f}`);
}

// Sample canonical Han forms (NFD of some 2F800 codepoints).
const sampleCompat = [0x2F800, 0x2F801, 0x2F806, 0x2F80c, 0x2F833, 0x2F8a0, 0x2F920, 0x2F9b4, 0x2F8b6, 0x2F8c9];
const canon = sampleCompat.map((cp) => String.fromCodePoint(cp).normalize("NFD").codePointAt(0));
// plus a broad sweep of all 2F800.0 canonical forms
const allCanon = [];
for (let cp = 0x2F800; cp <= 0x2F8FF; cp++) {
  const d = String.fromCodePoint(cp).normalize("NFD").codePointAt(0);
  if (d !== cp) allCanon.push(d);
}

for (const path of candidates) {
  let coll;
  try { coll = fontkit.openSync(path); } catch (e) { console.log(`(skip ${path}: ${e.message})`); continue; }
  const faces = coll.fonts ?? [coll];
  console.log(`\n${path}`);
  for (const ff of faces) {
    let covSample = 0; for (const c of canon) { try { if (ff.glyphForCodePoint(c).id !== 0) covSample++; } catch {} }
    let covAll = 0; for (const c of allCanon) { try { if (ff.glyphForCodePoint(c).id !== 0) covAll++; } catch {} }
    console.log(`  ${ff.postscriptName?.padEnd(28)} sample ${covSample}/${canon.length}  allCanon ${covAll}/${allCanon.length}`);
  }
}
