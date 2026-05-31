import * as fontkit from "fontkit";
function check(path, psn, label) {
  const f = fontkit.openSync(path);
  const font = psn != null ? f.getFont(psn) : f;
  const cps = [0x21D0, 0x21D1, 0x21D2, 0x21D3, 0x21D4, 0x21D5];
  for (const cp of cps) {
    const layout = font.layout(String.fromCodePoint(cp));
    const g = layout.glyphs[0];
    const adv = layout.positions[0].xAdvance * 32 / font.unitsPerEm;
    console.log(`  U+${cp.toString(16).toUpperCase()}  ${label} glyphId=${g.id} width=${adv.toFixed(2)}`);
  }
}
check("/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc", "HiraKakuProN-W3", "Hiragino Sans (JP)");
console.log();
check("/System/Library/Fonts/AppleSDGothicNeo.ttc", "AppleSDGothicNeo-Regular", "AppleSDGothicNeo");
console.log();
check("/System/Library/Fonts/Menlo.ttc", "Menlo-Regular", "Menlo");
