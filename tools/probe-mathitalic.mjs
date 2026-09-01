import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fontkit from 'fontkit';

const stixCands = ['/Library/Fonts/STIX2Math.otf', '/System/Library/Fonts/Supplemental/STIXTwoMath-Regular.otf', '/System/Library/Fonts/STIX 2.otf', '/Library/Fonts/STIXTwoMath-Regular.otf'];

/**
 * Find STIX font paths under one root without a shell. Missing/unreadable roots
 * return null, matching the old `2>/dev/null` + empty catch behavior.
 */
export function findStixFonts(directory, run = execFileSync, pathExists = existsSync) {
  if (!pathExists(directory)) return null;
  try {
    return run('find', [directory, '-iname', '*STIX*'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

export function runMathItalicProbe() {
  for (const p of stixCands) console.log(`exists ${p}: ${existsSync(p)}`);
  for (const directory of [
    '/System/Library/Fonts',
    '/Library/Fonts',
    join(homedir(), 'Library', 'Fonts'),
  ]) {
    const matches = findStixFonts(directory);
    if (matches != null) console.log(matches);
  }

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
}

if (process.argv[1] != null && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runMathItalicProbe();
}
