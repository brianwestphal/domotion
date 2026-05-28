import * as fontkit from 'fontkit';
import { execSync } from 'child_process';
// Compare fontkit shaping of "العربية" against Chrome's painted glyph IDs.
const fontPath = '/System/Library/Fonts/GeezaPro.ttc'; // macOS Arabic font
let font;
try {
  font = fontkit.openSync(fontPath);
  if (font.fonts) font = font.fonts[0];
  console.log('Font:', font.fullName, 'UPM:', font.unitsPerEm);
} catch (e) { console.log('No Geeza, trying SF Arabic'); }
if (!font) {
  try { font = fontkit.openSync('/System/Library/Fonts/SFArabic.ttf'); console.log('Font:', font.fullName); }
  catch (e) { console.log('No SF Arabic either'); process.exit(1); }
}
const text = 'العربية';
const layout = font.layout(text);
console.log(`\nFontkit layout of "${text}" (${text.length} chars):`);
console.log('Glyphs:', layout.glyphs.length);
for (let i = 0; i < layout.glyphs.length; i++) {
  const g = layout.glyphs[i];
  const pos = layout.positions[i];
  console.log(`  ${i}: id=${g.id} name="${g.name || ''}" cps=[${(g.codePoints||[]).map(c=>'U+'+c.toString(16).toUpperCase()).join(', ')}] xAdv=${pos.xAdvance}`);
}
