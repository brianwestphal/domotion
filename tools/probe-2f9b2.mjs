import * as fk from "fontkit";
const cp = 0x2F9B2;
const ch = String.fromCodePoint(cp);
console.log("U+2F9B2 NFD:", [...ch.normalize("NFD")].map((c) => c.codePointAt(0).toString(16)),
  "NFC:", [...ch.normalize("NFC")].map((c) => c.codePointAt(0).toString(16)));
const faces = [
  ["Hiragino JP", "/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc", "HiraKakuProN-W3"],
  ["Arial Unicode", "/System/Library/Fonts/Supplemental/Arial Unicode.ttf", null],
  ["Apple Symbols", "/System/Library/Fonts/Apple Symbols.ttf", null],
  ["Songti SC", "/System/Library/Fonts/Supplemental/Songti.ttc", "STSongti-SC-Light"],
  ["PingFang SC", "/System/Library/Fonts/PingFang.ttc", null],
  ["STHeiti", "/System/Library/Fonts/STHeiti Light.ttc", "STHeitiSC-Light"],
];
const dcp = ch.normalize("NFD").codePointAt(0);
for (const [name, p, ps] of faces) {
  let f;
  try { f = ps ? fk.openSync(p, ps) : fk.openSync(p); } catch { console.log(name, "open fail"); continue; }
  if (f.fonts) f = f.fonts[0];
  const lit = f.glyphForCodePoint(cp).id !== 0;
  const dec = f.glyphForCodePoint(dcp).id !== 0;
  console.log(name.padEnd(16), "literal:", lit, " decomp(" + dcp.toString(16) + "):", dec);
}
