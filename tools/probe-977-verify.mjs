import * as fontkit from "fontkit";
const ttc = fontkit.openSync("/System/Library/Fonts/AppleSDGothicNeo.ttc");
const font = ttc.getFont("AppleSDGothicNeo-Regular");
// Layout each codepoint and report advance width @ 32px font-size
const cps = [0x25a3, 0x25a4, 0x25a5, 0x25a6, 0x25a7, 0x25a8, 0x25a9];
for (const cp of cps) {
  const layout = font.layout(String.fromCodePoint(cp));
  const adv = (layout.positions[0].xAdvance * 32) / font.unitsPerEm;
  console.log(`U+${cp.toString(16).toUpperCase()}  AppleSDGothicNeo width @32px: ${adv.toFixed(2)}`);
}
