import * as fontkit from 'fontkit';
const stixCands = ['/Library/Fonts/STIX2Math.otf', '/System/Library/Fonts/Supplemental/STIXTwoMath-Regular.otf', '/System/Library/Fonts/STIX 2.otf', '/Library/Fonts/STIXTwoMath-Regular.otf'];
import { existsSync } from 'node:fs';
for (const p of stixCands) console.log(`exists ${p}: ${existsSync(p)}`);
const find = ['find', '/System/Library/Fonts', '-iname', '*STIX*'];
import { execSync } from 'node:child_process';
try { console.log(execSync('find /System/Library/Fonts -iname "*STIX*" 2>/dev/null').toString()); } catch {}
try { console.log(execSync('find /Library/Fonts -iname "*STIX*" 2>/dev/null').toString()); } catch {}
try { console.log(execSync('find ~/Library/Fonts -iname "*STIX*" 2>/dev/null').toString()); } catch {}
const chars = [0x1D465, 0x1D44E, 0x1D44F, 0x1D44D, 0x1D434, 0x203E];
const fonts = [
  ['symbols', '/System/Library/Fonts/Apple Symbols.ttf'],
  ['helvetica', '/System/Library/Fonts/Helvetica.ttc'],
];
for (const [name, path] of fonts) {
  let f;
  try { const opened = fontkit.openSync(path); f = opened.fonts ? opened.fonts[0] : opened; }
  catch (e) { console.log(`${name.padEnd(15)} FAILED (${e.message})`); continue; }
  const cells = chars.map(cp => `U+${cp.toString(16).toUpperCase()}=${f.glyphForCodePoint(cp).id}`);
  console.log(`${name.padEnd(15)} ${cells.join(' ')}`);
}
