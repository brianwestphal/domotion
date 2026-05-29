import * as fontkit from 'fontkit';
const font = fontkit.openSync("/System/Library/Fonts/Helvetica.ttc");
const f = font.fonts ? font.fonts[0] : font;
const layout = f.layout(" (one) ");
console.log("text: ' (one) '  glyphs:", layout.glyphs.length);
for (let i = 0; i < layout.glyphs.length; i++) {
  const g = layout.glyphs[i];
  console.log(`  glyph ${i}: id=${g.id} cps=[${(g.codePoints || []).map(c => 'U+'+c.toString(16)).join(',')}] xAdv=${g.advanceWidth}`);
}
// What about a hebrew word?
const layoutHe = f.layout("שלום");
console.log("\ntext: 'שלום'  glyphs:", layoutHe.glyphs.length);
for (let i = 0; i < layoutHe.glyphs.length; i++) {
  const g = layoutHe.glyphs[i];
  console.log(`  glyph ${i}: id=${g.id} cps=[${(g.codePoints || []).map(c => 'U+'+c.toString(16)).join(',')}] xAdv=${g.advanceWidth}`);
}
