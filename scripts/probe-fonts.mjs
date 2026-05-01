import * as fontkit from 'fontkit';
import { existsSync } from 'node:fs';

const fonts = [
  ['/System/Library/Fonts/Helvetica.ttc', 'Helvetica'],
  ['/System/Library/Fonts/HiraginoSans.ttc', null],
  ['/System/Library/Fonts/Apple Symbols.ttf', null],
  ['/System/Library/Fonts/AppleSDGothicNeo.ttc', null],
  ['/System/Library/Fonts/SFNS.ttf', null],
  ['/System/Library/Fonts/SFNSMono.ttf', null],
  ['/System/Library/Fonts/Supplemental/Zapfino.ttf', null],
  ['/System/Library/Fonts/LucidaGrande.ttc', 'LucidaGrande'],
];

const codepoints = [0x25A0, 0x25A1, 0x25A3, 0x25A4, 0x25A5, 0x25A6, 0x25A7, 0x25A8,
  0x25C6, 0x25C7, 0x25C8, 0x25CB, 0x25CF, 0x25D0, 0x25D1,
  0x2605, 0x2606, 0x2611, 0x2612, 0x2660, 0x2663, 0x2665, 0x2666,
  0x2640, 0x2642, 0x26A5, 0x2610, 0x2613];

for (const [path, faceName] of fonts) {
  if (!existsSync(path)) { console.log(`SKIP ${path}`); continue; }
  let f;
  try {
    f = faceName ? fontkit.openSync(path, faceName) : fontkit.openSync(path);
    if (Array.isArray(f.fonts)) f = f.fonts[0];
  } catch (e) {
    console.log(`ERR ${path}: ${e.message}`);
    continue;
  }
  const upm = f.unitsPerEm;
  console.log(`\n=== ${path} ${f.fullName ?? f.postscriptName} (upm=${upm}) ===`);
  const fontSize = 18;
  for (const cp of codepoints) {
    try {
      const g = f.glyphForCodePoint(cp);
      if (!g || g.id === 0) continue;
      const adv = g.advanceWidth * fontSize / upm;
      const cpHex = `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
      console.log(`  ${cpHex}: gid=${g.id}  adv@18=${adv.toFixed(2)}`);
    } catch (e) {}
  }
}
