import * as fontkit from "fontkit";
const ttc = fontkit.openSync("/System/Library/Fonts/Supplemental/Gurmukhi Sangam MN.ttc");
const font = ttc.getFont("GurmukhiSangamMN");
console.log("Got font:", font.postscriptName, "numGlyphs:", font.numGlyphs);
// Layout one char
const layout = font.layout("ਆ");
console.log("Layout glyphs:", layout.glyphs.length);
console.log("First glyph path commands:", layout.glyphs[0]?.path?.commands?.length);
// Layout all 100+ characters in the block
let allChars = "";
for (let cp = 0x0A01; cp <= 0x0A75; cp++) {
  allChars += String.fromCodePoint(cp);
}
console.log("Charset length:", allChars.length);
try {
  const big = font.layout(allChars);
  console.log("Big layout glyphs:", big.glyphs.length);
  // Check path command counts
  let totalCommands = 0;
  for (const g of big.glyphs) totalCommands += g.path?.commands?.length || 0;
  console.log("Total path commands:", totalCommands);
} catch(e) { console.error("Big layout failed:", e.message); }
