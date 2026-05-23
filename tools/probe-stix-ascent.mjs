import * as fontkit from "fontkit";

const stixPath = "/System/Library/Fonts/Supplemental/STIXTwoMath.otf";
const sfPath = "/System/Library/Fonts/SFNS.ttf";

for (const p of [stixPath, sfPath]) {
  try {
    const f = fontkit.openSync(p);
    console.log(`\n${p}:`);
    console.log(`  postscriptName: ${f.postscriptName}`);
    console.log(`  unitsPerEm: ${f.unitsPerEm}`);
    console.log(`  ascent: ${f.ascent}`);
    console.log(`  descent: ${f.descent}`);
    console.log(`  lineGap: ${f.lineGap}`);
    console.log(`  capHeight: ${f.capHeight}`);
    console.log(`  xHeight: ${f.xHeight}`);
    console.log(`  bbox: ${JSON.stringify(f.bbox)}`);
    // Compute scale at 22px
    const s = 22 / f.unitsPerEm;
    console.log(`  at 22px:`);
    console.log(`    ascent: ${(f.ascent * s).toFixed(2)} px`);
    console.log(`    descent: ${(f.descent * s).toFixed(2)} px`);
    console.log(`    line-h: ${((f.ascent - f.descent + f.lineGap) * s).toFixed(2)} px`);
    // Probe `(` glyph
    const layout = f.layout("(");
    const g = layout.glyphs[0];
    console.log(`  ( glyph bbox: ${JSON.stringify(g.bbox)}`);
    console.log(`  ( at 22px ink: ascent=${(g.bbox.maxY * s).toFixed(2)} descent=${(-g.bbox.minY * s).toFixed(2)}`);
  } catch (e) {
    console.log(`${p}: ${e.message}`);
  }
}
