import * as fontkit from "fontkit";
const opened = fontkit.openSync("/System/Library/Fonts/Supplemental/STIXTwoMath.otf");
const f = opened.fonts ? opened.fonts[0] : opened;
const chars = [0x1d465, 0x1d434, 0x1d44e, 0x203e, 0x2192, 0x222b];
for (const cp of chars) {
  const g = f.glyphForCodePoint(cp);
  console.log(`U+${cp.toString(16).toUpperCase()} = ${String.fromCodePoint(cp)} → id=${g.id}`);
}
