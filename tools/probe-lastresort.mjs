// Inspect LastResort.otf's glyph table + cmap to see what fontkit can extract.
import * as fontkit from "fontkit";
const f = fontkit.openSync("/System/Library/Fonts/LastResort.otf");
console.log("numGlyphs:", f.numGlyphs);
console.log("postscriptName:", f.postscriptName);

const tests = [
  { name: "Egyptian Hieroglyph", cp: 0x13668 },
  { name: "SignWriting",         cp: 0x1D800 },
  { name: "CJK Ext-G",           cp: 0x305D6 },
  { name: "BMP / Latin A",       cp: 0x41 },
  { name: "BMP / Hebrew",        cp: 0x05D0 },
  { name: "BMP / CJK",           cp: 0x4E00 },
  { name: "Surrogate-area-mid",  cp: 0xDC00 }, // private
  { name: "SMP Mahjong",         cp: 0x1F000 },
  { name: "SIP",                 cp: 0x2A700 },
];
for (const t of tests) {
  const g = f.glyphForCodePoint(t.cp);
  console.log(`  ${t.name} U+${t.cp.toString(16).padStart(4, "0").toUpperCase()}: glyphId=${g.id} advance=${g.advanceWidth}`);
}

// Inspect glyph 4 path
const g4 = f.getGlyph(4);
const g4path = g4.path.toSVG();
console.log("\nGlyph 4 SVG path:", g4path.slice(0, 500));
console.log("Glyph 4 bbox:", g4.bbox);

// Inspect glyph 4 commands
console.log("\nGlyph 4 commands:", JSON.stringify(g4.path.commands).slice(0, 500));

// Try font.layout — sometimes layout substitutes via GSUB to a different glyph
const layoutTests = ["፦8", "𝄀", "𠀀", "A"];
console.log("\nlayout() results:");
for (const t of layoutTests) {
  try {
    const r = f.layout(t);
    console.log(`  ${JSON.stringify(t)}: ids=${r.glyphs.map(g => g.id).join(",")}`);
  } catch (e) { console.log(`  ${JSON.stringify(t)}: error ${e.message}`); }
}
