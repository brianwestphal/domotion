import * as fontkit from "fontkit";
const sym = fontkit.openSync("/System/Library/Fonts/Apple Symbols.ttf");
const helv = fontkit.openSync("/System/Library/Fonts/Helvetica.ttc","Helvetica");
const cps = [0xA722,0xA723,0xA724,0xA72D,0xA72E,0xA72F];
for (const cp of cps) {
  const s = sym.glyphForCodePoint(cp).id;
  console.log(`U+${cp.toString(16).toUpperCase()}: AppleSymbols=${s}${s===0?" (none)":""}`);
}
