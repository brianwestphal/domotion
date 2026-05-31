import * as fontkit from "fontkit";
const cjk = fontkit.openSync("/System/Library/Fonts/Hiragino Sans GB.ttc").getFont("HiraginoSansGB-W3");
const jp = fontkit.openSync("/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc").getFont("HiraKakuProN-W3");
for (const cp of [0x2605, 0x2606, 0x2665, 0x2666, 0x2660, 0x2663]) {
  for (const [n, f] of [["CJK-GB", cjk], ["Hira-JP", jp]]) {
    const g = f.glyphForCodePoint(cp);
    if (g.id === 0) { console.log(`U+${cp.toString(16)}  ${n}  NO GLYPH`); continue; }
    const layout = f.layout(String.fromCodePoint(cp));
    const adv = layout.positions[0].xAdvance * 32 / f.unitsPerEm;
    // Ink bounds
    const bb = g.bbox;
    console.log(`U+${cp.toString(16)}  ${n}  glyph=${g.id}  width=${adv.toFixed(2)}  bbox=[${bb.minX},${bb.minY},${bb.maxX},${bb.maxY}]  unitsPerEm=${f.unitsPerEm}`);
  }
  console.log();
}
