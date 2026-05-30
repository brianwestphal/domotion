import * as fontkit from "fontkit";
const ttc = fontkit.openSync("/System/Library/Fonts/Supplemental/Gurmukhi Sangam MN.ttc");
const font = ttc.getFont("GurmukhiSangamMN");
// Try layout per codepoint to find which one crashes
for (let cp = 0x0A01; cp <= 0x0A75; cp++) {
  const s = String.fromCodePoint(cp);
  try {
    const l = font.layout(s);
    process.stdout.write(`U+${cp.toString(16)} ok ${l.glyphs.length}g\n`);
  } catch(e) {
    process.stdout.write(`U+${cp.toString(16)} ERROR: ${e.message}\n`);
  }
}
