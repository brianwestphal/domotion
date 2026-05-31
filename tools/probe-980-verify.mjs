import * as fontkit from "fontkit";
const lucida = fontkit.openSync("/System/Library/Fonts/LucidaGrande.ttc").getFont("LucidaGrande");
const zapf = fontkit.openSync("/System/Library/Fonts/Apple Symbols.ttf");
const dingbats = fontkit.openSync("/System/Library/Fonts/ZapfDingbats.ttf");
for (const [name, f] of [["LucidaGrande", lucida], ["AppleSymbols", zapf], ["ZapfDingbats", dingbats]]) {
  const g = f.glyphForCodePoint(0x2713);
  const layout = f.layout("✓");
  const adv = layout.positions[0].xAdvance * 32 / f.unitsPerEm;
  console.log(`U+2713  ${name.padEnd(14)} glyphId=${g.id} width=${adv.toFixed(2)}`);
}
