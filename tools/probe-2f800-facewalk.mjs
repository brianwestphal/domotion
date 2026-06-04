// DM-1083 empirical gate: for the CJK Compatibility Ideographs Supplement block
// (U+2F800–2FA1D), determine — per codepoint — WHICH face in the fixture's CSS
// font stack supplies Chrome's painted glyph, and whether via the LITERAL cmap
// or an in-font canonical (NFD/NFC singleton) decomposition. This calibrates the
// new "walk the whole CSS family list, test cmap-then-decomposition per font"
// resolver loop and answers the ticket's open question: do Chrome's extra ~36
// cells (vs our primary-only resolver) come from later-declared INSTALLED
// families, or from the per-char OS fallback step?
//
// Method (probe-and-match per the project fidelity rule):
//  - Chrome side: render each literal char with the fixture's real stack and
//    cluster painted-ink signatures; the dominant identical cluster = the
//    primary's `.notdef` tofu. Any cp NOT in that cluster = Chrome painted a
//    real glyph.
//  - Font side (fontkit): walk the fixture's installed stack in order
//    [Hiragino Sans JP, Arial Unicode MS, Apple Symbols]; for each face test
//    glyphForCodePoint(cp) (literal) then glyphForCodePoint(decomp) where decomp
//    is the canonical NFD/NFC singleton. First face to cover wins.
import { chromium } from "@playwright/test";
import * as fontkit from "fontkit";

// Fixture's effective INSTALLED stack for the default `x>g` cells, in CSS order.
// (Apple Color Emoji / Noto Sans / Noto Serif from the stack are color-emoji or
// not installed on this host, so they can't supply a CJK ideograph here.)
const STACK = [
  { key: "Hiragino Sans (JP)", path: "/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc", ps: "HiraKakuProN-W3" },
  { key: "Arial Unicode MS",   path: "/System/Library/Fonts/Supplemental/Arial Unicode.ttf" },
  { key: "Apple Symbols",      path: "/System/Library/Fonts/Apple Symbols.ttf" },
];
// Extra faces declared by the .f1/.f2 variant cells (Heiti SC / Songti SC).
const EXTRA = [
  { key: "Songti SC",  path: "/System/Library/Fonts/Supplemental/Songti.ttc", ps: "STSongti-SC-Light" },
  { key: "Heiti SC",   path: "/System/Library/Fonts/STHeiti Light.ttc", ps: "STHeitiSC-Light" },
];

function openFace(spec) {
  try {
    const f = fontkit.openSync(spec.path, spec.ps);
    return f.glyphForCodePoint ? f : (f.fonts ? f.fonts[0] : null);
  } catch { return null; }
}
const faces = [...STACK, ...EXTRA].map((s) => ({ ...s, face: openFace(s) }));
for (const f of faces) if (!f.face) console.log(`!! could not open ${f.key} @ ${f.path}`);

function covers(face, cp) {
  if (!face || !face.glyphForCodePoint) return false;
  try { return face.glyphForCodePoint(cp).id !== 0; } catch { return false; }
}
// First face in `list` covering cp literally or via canonical singleton decomp.
function firstCovering(list, cp) {
  const ch = String.fromCodePoint(cp);
  const nfd = ch.normalize("NFD");
  const dcp = nfd.codePointAt(0);
  const singleton = dcp != null && dcp !== cp && String.fromCodePoint(dcp) === nfd ? dcp : null;
  for (const f of list) {
    if (covers(f.face, cp)) return { face: f.key, via: "literal" };
    if (singleton != null && covers(f.face, singleton)) return { face: f.key, via: "decomp", dcp: singleton.toString(16) };
  }
  return null;
}

const cps = [];
for (let cp = 0x2F800; cp <= 0x2FA1D; cp++) cps.push(cp);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 200, height: 200 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
await page.setContent(`<!doctype html><meta charset=utf-8><body></body>`);
await page.waitForLoadState("networkidle");

// Chrome paint signature per cp, using the fixture's actual default stack.
const stackCss = `"Hiragino Sans","Arial Unicode MS","Apple Symbols","Apple Color Emoji","Noto Sans","Noto Serif",sans-serif`;
const chrome = await page.evaluate(({ cps, stackCss }) => {
  const cnv = document.createElement("canvas");
  cnv.width = 64; cnv.height = 64;
  const g = cnv.getContext("2d", { willReadFrequently: true });
  function sig(str) {
    g.clearRect(0, 0, 64, 64);
    g.fillStyle = "#000";
    g.font = `32px ${stackCss}`;
    g.textBaseline = "top";
    g.fillText(str, 2, 2);
    const d = g.getImageData(0, 0, 64, 64).data;
    let ink = 0, hash = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 32) { ink++; hash = (hash * 31 + ((i >> 2))) | 0; }
    return ink + ":" + hash;
  }
  const out = {};
  for (const cp of cps) out[cp] = sig(String.fromCodePoint(cp));
  return out;
}, { cps, stackCss });
await browser.close();

// Dominant identical signature = the tofu placeholder.
const counts = new Map();
for (const cp of cps) counts.set(chrome[cp], (counts.get(chrome[cp]) || 0) + 1);
const tofuSig = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];

let chromePaints = 0, primaryOnly = 0, walkCovers = 0;
let walkMatchesChrome = 0, walkOverPaints = 0, walkUnderPaints = 0;
const viaCounts = { literal: 0, decomp: 0 };
const byFace = new Map();
const mismatches = [];
for (const cp of cps) {
  const chromeGlyph = chrome[cp] !== tofuSig;          // Chrome painted a real glyph
  if (chromeGlyph) chromePaints++;
  const prim = firstCovering([faces[0]], cp);          // primary-only (Hiragino) — our current effective resolver for this stack
  if (prim) primaryOnly++;
  const walk = firstCovering(STACK.map((s) => faces.find((f) => f.key === s.key)), cp); // full installed CSS-stack walk
  if (walk) {
    walkCovers++;
    viaCounts[walk.via]++;
    byFace.set(`${walk.face} (${walk.via})`, (byFace.get(`${walk.face} (${walk.via})`) || 0) + 1);
  }
  const walkGlyph = walk != null;
  if (walkGlyph === chromeGlyph) walkMatchesChrome++;
  else if (walkGlyph && !chromeGlyph) { walkOverPaints++; mismatches.push({ cp: cp.toString(16), kind: "OVER", walk }); }
  else if (!walkGlyph && chromeGlyph) { walkUnderPaints++; mismatches.push({ cp: cp.toString(16), kind: "UNDER" }); }
}

console.log(`\n=== DM-1083 face-walk probe: U+2F800–2FA1D (${cps.length} codepoints) ===\n`);
console.log(`Chrome paints a real glyph in:        ${chromePaints} / ${cps.length} cells`);
console.log(`Primary-only (Hiragino) covers:       ${primaryOnly} cells`);
console.log(`Full CSS-stack walk covers:           ${walkCovers} cells   (+${walkCovers - primaryOnly} vs primary-only)`);
console.log(`  via literal cmap:  ${viaCounts.literal}`);
console.log(`  via in-font decomp: ${viaCounts.decomp}`);
console.log(`\nWhich face supplies each covered cell (first in CSS order):`);
for (const [k, n] of [...byFace.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(28)} ${n}`);
console.log(`\nNew-loop vs Chrome agreement:`);
console.log(`  matches Chrome (glyph/tofu both agree): ${walkMatchesChrome} / ${cps.length}`);
console.log(`  walk OVER-paints (we glyph, Chrome tofu): ${walkOverPaints}`);
console.log(`  walk UNDER-paints (we tofu, Chrome glyph): ${walkUnderPaints}`);
if (mismatches.length) {
  console.log(`\nFirst 20 mismatches:`);
  for (const m of mismatches.slice(0, 20)) console.log(`  U+${m.cp} ${m.kind}${m.walk ? " " + JSON.stringify(m.walk) : ""}`);
}
