import * as fontkit from 'fontkit';
const chars = [0x203E, 0x00AF, 0x0304, 0x2192, 0x2225];
const fonts = [
  ['stix-math', '/Library/Fonts/STIX2Math.otf'],
  ['symbols', '/System/Library/Fonts/Apple Symbols.ttf'],
  ['lucida-grande', '/System/Library/Fonts/LucidaGrande.ttc'],
  ['helvetica', '/System/Library/Fonts/Helvetica.ttc'],
  ['hiragino-jp', '/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc'],
];
for (const [name, path] of fonts) {
  let f;
  try { const opened = fontkit.openSync(path); f = opened.fonts ? opened.fonts[0] : opened; }
  catch (e) { console.log(`${name.padEnd(15)} FAILED (${e.message})`); continue; }
  const cells = chars.map(cp => {
    const g = f.glyphForCodePoint(cp);
    return `U+${cp.toString(16).toUpperCase()}=${g.id}`;
  });
  console.log(`${name.padEnd(15)} ${cells.join(' ')}`);
}
