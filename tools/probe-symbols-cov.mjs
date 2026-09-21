import * as fontkit from "fontkit";
const sym = fontkit.openSync("/System/Library/Fonts/Apple Symbols.ttf");
const helv = fontkit.openSync("/System/Library/Fonts/Helvetica.ttc", "Helvetica");
const cps = [0xa722, 0xa723, 0xa724, 0xa72d, 0xa72e, 0xa72f];
for (const cp of cps) {
  const s = sym.glyphForCodePoint(cp).id;
  console.log(`U+${cp.toString(16).toUpperCase()}: AppleSymbols=${s}${s === 0 ? " (none)" : ""}`);
}
