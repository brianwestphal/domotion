import * as fontkit from "fontkit";
const ttc = fontkit.openSync("/System/Library/Fonts/Supplemental/Gurmukhi Sangam MN.ttc");
const font = ttc.getFont("GurmukhiSangamMN");
// Layout per codepoint INDIVIDUALLY with try/catch
for (let cp = 0x0A01; cp <= 0x0A75; cp++) {
  const s = String.fromCodePoint(cp);
  process.stdout.write(`Trying U+${cp.toString(16).toUpperCase()}... `);
  process.stdout.write("\n");
  try {
    const l = font.layout(s);
    process.stdout.write(`  ok ${l.glyphs.length}g\n`);
  } catch(e) {
    process.stdout.write(`  ERROR: ${e.message}\n`);
  }
}
