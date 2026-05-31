import * as fontkit from "fontkit";
const helv = fontkit.openSync("/System/Library/Fonts/Helvetica.ttc").getFont("Helvetica");
const lg = fontkit.openSync("/System/Library/Fonts/LucidaGrande.ttc").getFont("LucidaGrande");
const sym = fontkit.openSync("/System/Library/Fonts/Apple Symbols.ttf");
for (const cp of [0x211A, 0x2135]) {
  for (const [n, f] of [["Helv", helv], ["LG", lg], ["Sym", sym]]) {
    const g = f.glyphForCodePoint(cp);
    if (g.id === 0) { console.log(`U+${cp.toString(16)}  ${n} NO GLYPH`); continue; }
    const adv = f.layout(String.fromCodePoint(cp)).positions[0].xAdvance * 32 / f.unitsPerEm;
    console.log(`U+${cp.toString(16)}  ${n} glyph=${g.id} width=${adv.toFixed(2)}`);
  }
  console.log();
}
