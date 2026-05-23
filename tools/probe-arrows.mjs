import * as fontkit from 'fontkit';
const chars = [0x2190, 0x2191, 0x2192, 0x2193, 0x2194, 0x2195, 0x2196, 0x2197, 0x2198, 0x2199, 0x21D0, 0x21D1, 0x21D2, 0x21D3, 0x21D4, 0x21D5];
const fonts = [
  ['symbols', '/System/Library/Fonts/Apple Symbols.ttf'],
  ['lucida-grande', '/System/Library/Fonts/LucidaGrande.ttc'],
  ['hiragino-jp', '/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc'],
  ['cjk', '/System/Library/Fonts/Hiragino Sans GB.ttc'],
  ['stix-math', '/System/Library/Fonts/Supplemental/STIXTwoMath-Regular.otf'],
];
for (const [name, path] of fonts) {
  let f;
  try { const opened = fontkit.openSync(path); f = opened.fonts ? opened.fonts[0] : opened; }
  catch (e) { console.log(`${name}: FAILED to open (${e.message})`); continue; }
  const cells = chars.map(cp => {
    const g = f.glyphForCodePoint(cp);
    const ch = String.fromCodePoint(cp);
    return `${ch}=${g.id}`;
  });
  console.log(`${name.padEnd(15)} ${cells.join(' ')}`);
}
