import * as fontkit from "fontkit";
const ttc = fontkit.openSync("/System/Library/Fonts/Supplemental/Tamil Sangam MN.ttc");
for (const f of ttc.fonts) {
  console.log("Sub-font:", f.postscriptName, "/", f.familyName);
  const cmap = f.characterSet;
  const granthaCovered = cmap.filter(cp => cp >= 0x11300 && cp <= 0x1137F).length;
  const tamilCovered = cmap.filter(cp => cp >= 0x0B80 && cp <= 0x0BFF).length;
  console.log("  Grantha (0x11300-1137F):", granthaCovered, "codepoints");
  console.log("  Tamil   (0x0B80-0BFF):", tamilCovered, "codepoints");
  // Get glyph 1 if codepoint is in cmap
  console.log("  Has U+11305?", f.glyphForCodePoint(0x11305)?.id);
}
