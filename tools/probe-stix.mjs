import * as fontkit from 'fontkit';
const opened = fontkit.openSync('/System/Library/Fonts/Supplemental/STIXTwoMath.otf');
const f = opened.fonts ? opened.fonts[0] : opened;
const chars = [0x1D465, 0x1D434, 0x1D44E, 0x203E, 0x2192, 0x222B];
for (const cp of chars) {
  const g = f.glyphForCodePoint(cp);
  console.log(`U+${cp.toString(16).toUpperCase()} = ${String.fromCodePoint(cp)} → id=${g.id}`);
}
