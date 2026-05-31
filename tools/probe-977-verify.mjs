import * as fontkit from "fontkit";
const ttc = fontkit.openSync("/System/Library/Fonts/AppleSDGothicNeo.ttc");
const font = ttc.getFont("AppleSDGothicNeo-Regular");
// Layout each codepoint and report advance width @ 32px font-size
const cps = [0x25A3, 0x25A4, 0x25A5, 0x25A6, 0x25A7, 0x25A8, 0x25A9];
for (const cp of cps) {
  const layout = font.layout(String.fromCodePoint(cp));
  const adv = layout.positions[0].xAdvance * 32 / font.unitsPerEm;
  console.log(`U+${cp.toString(16).toUpperCase()}  AppleSDGothicNeo width @32px: ${adv.toFixed(2)}`);
}
