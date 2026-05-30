import * as fontkit from "fontkit";
const fonts = [
  ["/System/Library/Fonts/Hiragino Sans GB.ttc", "HiraginoSansGB-W3"],
  ["/System/Library/Fonts/Hiragino Sans GB.ttc", "HiraginoSansGB-W6"],
  ["/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc", "HiraKakuProN-W3"],
  ["/System/Library/Fonts/AppleSDGothicNeo.ttc", "AppleSDGothicNeo-Regular"],
  ["/System/Library/Fonts/PingFang.ttc", "PingFangSC-Regular"],
  ["/System/Library/Fonts/Apple Symbols.ttf", null],
];
for (const [path, ps] of fonts) {
  try {
    const file = fontkit.openSync(path);
    const font = ps && file.fonts ? file.getFont(ps) : (file.fonts ? file.fonts[0] : file);
    if (!font) continue;
    const glyph = font.glyphForCodePoint(0x25C8);
    if (!glyph || glyph.id === 0) { console.log(`  ${path} (${ps}): NO GLYPH`); continue; }
    const adv = glyph.advanceWidth * 18 / font.unitsPerEm;
    console.log(`  ${path} (${ps || font.fullName}): glyph ${glyph.id}, advance ${adv.toFixed(2)}px @ 18`);
  } catch (e) { console.log(`  ${path}: ${e.message}`); }
}
