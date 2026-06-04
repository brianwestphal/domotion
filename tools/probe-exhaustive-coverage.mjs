import * as fontkit from "fontkit";
import { readFileSync, readdirSync } from "node:fs";

// Extract the fixture's exact codepoints from its <n>U+XXXX</n> labels.
const html = readFileSync("../html-test/unicode/2F800-2FA1F-cjk-compatibility-ideographs-supplement.0.html", "utf-8");
const cps = [...html.matchAll(/U\+([0-9A-Fa-f]{4,6})/g)].map((m) => parseInt(m[1], 16)).filter((cp) => cp >= 0x2F800 && cp <= 0x2FA1D);
const uniq = [...new Set(cps)];
console.log(`Fixture .0 codepoints: ${uniq.length}`);

// Enumerate every macOS font file.
const dirs = ["/System/Library/Fonts", "/System/Library/Fonts/Supplemental", "/Library/Fonts"];
const files = [];
for (const d of dirs) {
  try { for (const f of readdirSync(d)) if (/\.(ttf|ttc|otf|otc)$/i.test(f)) files.push(`${d}/${f}`); } catch {}
}
const faces = [];
for (const p of files) {
  try { const fk = fontkit.openSync(p); for (const ff of (fk.fonts ?? [fk])) faces.push(ff); } catch {}
}
console.log(`Scanned ${files.length} font files, ${faces.length} faces.`);

function litCovered(cp) {
  for (const ff of faces) { try { if (ff.glyphForCodePoint(cp).id !== 0) return true; } catch {} }
  return false;
}
function nfdCovered(cp) {
  const nfd = String.fromCodePoint(cp).normalize("NFD");
  const dcp = nfd.codePointAt(0);
  if (dcp === cp) return false;
  for (const ff of faces) { try { if (ff.glyphForCodePoint(dcp).id !== 0) return true; } catch {} }
  return false;
}

let lit = 0, onlyNfd = 0, neither = 0;
for (const cp of uniq) {
  if (litCovered(cp)) lit++;
  else if (nfdCovered(cp)) onlyNfd++;
  else neither++;
}
console.log(`\nExhaustive macOS coverage of the ${uniq.length} fixture codepoints:`);
console.log(`  LITERAL covered by some macOS font: ${lit}`);
console.log(`  literal UNcovered but CANONICAL(NFD) covered: ${onlyNfd}`);
console.log(`  neither: ${neither}`);
console.log(`\nChrome renders ~205 real / ~55 tofu. If LITERAL≈205 → Chrome uses literal coverage (decomp is wrong model).`);
console.log(`If LITERAL≈43 and onlyNfd large → Chrome decomposes (NFD is right, just over-broad).`);
