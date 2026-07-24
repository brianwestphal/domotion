// Rebuild the deterministic fixture faces under `assets/fonts/fixture/`.
//
// WHY THESE EXIST
//   The frame-sequence compressor's e2e fixtures assert pixel parity between a
//   compressed run and the uncompressed flipbook of the same state, bounded by
//   the no-motion caps in `src/review/compare-pngs.ts` (`strictCapsFor`). Both
//   images come out of our own renderer, so the caps only have to absorb the
//   sub-pixel phase difference the compressor's transform groups introduce —
//   but the SIZE of that drift depends on the glyph outlines being rasterized.
//
//   When the fixtures asked for host-dependent families (`Menlo`,
//   `system-ui`, `Georgia`) they got a different face on every platform, so the
//   clean drift ceiling moved with the host: 88 px largest region on macOS
//   against 829 px in the Linux container, the latter overlapping a known
//   compressor break at 3712 px. No single cap could both pass a correct build
//   and fail a broken one. Pinning the fixtures to bundled faces collapses the
//   ceiling to one number on every platform, which is what lets one cap set
//   gate all three.
//
// UPSTREAM SOURCES (both SIL Open Font License 1.1 — see the LICENSE files
// next to the outputs; neither is modified beyond subsetting)
//   JetBrains Mono Regular
//     https://raw.githubusercontent.com/JetBrains/JetBrainsMono/master/fonts/ttf/JetBrainsMono-Regular.ttf
//   IBM Plex Serif Regular
//     https://raw.githubusercontent.com/google/fonts/main/ofl/ibmplexserif/IBMPlexSerif-Regular.ttf
//
// USAGE
//   curl -sLo /tmp/JetBrainsMono-Regular.ttf <url above>
//   curl -sLo /tmp/IBMPlexSerif-Regular.ttf  <url above>
//   node tools/build-fixture-fonts.mjs /tmp/JetBrainsMono-Regular.ttf /tmp/IBMPlexSerif-Regular.ttf
//
// The subset is deterministic: same inputs + same harfbuzzjs version produce
// byte-identical outputs, so re-running this must leave `git status` clean
// unless an input or the charset below actually changed.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as fontkit from "fontkit";
import { hbSubsetRetainGids } from "../dist/render/hb-subset.js";
import { buildSfnt } from "../dist/render/synth-test-fonts.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "assets", "fonts", "fixture");

/** Everything the compressor fixtures paint: printable ASCII plus the few
 *  punctuation codepoints their chrome uses. Keep this list in sync when a
 *  fixture introduces a character outside it — an uncovered codepoint would
 *  cascade past the bundled face to a host font and reintroduce exactly the
 *  platform dependence these files exist to remove. */
const CHARSET = [
  ...Array.from({ length: 0x7e - 0x20 + 1 }, (_, i) => 0x20 + i), // printable ASCII
  0x00a0, // no-break space
  0x2013, // en dash
  0x2014, // em dash (the editor titlebar's "app.tsx — probe")
  0x2018, 0x2019, 0x201c, 0x201d, // curly quotes
  0x2026, // horizontal ellipsis
];

/** Tables dropped after subsetting.
 *
 *  hb-subset is run with RETAIN_GIDS (the wrapper's fixed mode), which keeps
 *  the source's glyph numbering — so the output still declares ~1750 glyph ids
 *  while only ~100 carry outlines. OpenType layout tables survive that with
 *  coverage entries pointing at glyph ids whose data is gone, and fontkit
 *  throws "Offset is outside the bounds of the DataView" the moment a string
 *  routes through them: `font.layout("=>")` and `font.layout("… count.value++…")`
 *  both failed on the un-dropped subset, which the renderer catches and
 *  downgrades to a plain `<text>` element — losing per-segment positioning and
 *  visibly garbling any line built from several text nodes.
 *
 *  These fixtures paint ASCII with no shaping requirement, so the tables buy
 *  nothing. Dropping them also removes the programming ligatures (`=>`, `++`)
 *  the source mono face carries, which is what we want: the fixtures model an
 *  editor rendered in a plain monospace face, matching what they did while they
 *  asked for Menlo. */
const DROP_TABLES = ["GSUB", "GPOS", "GDEF"];

/** Re-emit an sfnt without `DROP_TABLES`, preserving every other table byte for
 *  byte (`buildSfnt` recomputes the directory, padding and checksums). */
function dropLayoutTables(bytes) {
  const numTables = bytes.readUInt16BE(4);
  const tables = {};
  for (let i = 0; i < numTables; i++) {
    const o = 12 + i * 16;
    const tag = bytes.toString("latin1", o, o + 4);
    if (DROP_TABLES.includes(tag)) continue;
    const off = bytes.readUInt32BE(o + 8);
    const len = bytes.readUInt32BE(o + 12);
    tables[tag] = bytes.subarray(off, off + len);
  }
  return buildSfnt(tables);
}

function subset(srcPath, outName) {
  const bytes = readFileSync(srcPath);
  const font = fontkit.create(bytes);
  const gids = new Set([0]);
  const missing = [];
  for (const cp of CHARSET) {
    const g = font.glyphForCodePoint(cp);
    if (g == null || g.id === 0) missing.push(cp);
    else gids.add(g.id);
  }
  if (missing.length > 0) {
    throw new Error(
      `${outName}: source font does not cover ${missing.length} codepoint(s): `
      + missing.map((c) => `U+${c.toString(16).toUpperCase().padStart(4, "0")}`).join(" "),
    );
  }
  // RETAIN_GIDS keeps the original cmap valid for the glyphs we kept, and the
  // ASCII gids sit low in both faces so the retained-gid `loca` stays compact.
  const out = dropLayoutTables(hbSubsetRetainGids(bytes, [...gids], 0, true, null));
  // Fail loudly rather than shipping a face the renderer would silently
  // downgrade to `<text>`: shape every fixture character, plus the sequences
  // that first exposed the layout-table breakage.
  const check = fontkit.create(out);
  for (const s of [CHARSET.map((c) => String.fromCodePoint(c)).join(""), "=>", "count.value++);"]) {
    check.layout(s);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, outName), out);
  console.log(`${outName}: ${bytes.length} -> ${out.length} bytes (${gids.size} glyphs)`);
}

const [monoSrc, serifSrc] = process.argv.slice(2);
if (!monoSrc || !serifSrc) {
  console.error("usage: node tools/build-fixture-fonts.mjs <JetBrainsMono-Regular.ttf> <IBMPlexSerif-Regular.ttf>");
  process.exit(2);
}
subset(monoSrc, "DomotionFixtureMono-Regular.ttf");
subset(serifSrc, "DomotionFixtureSerif-Regular.ttf");
