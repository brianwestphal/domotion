import * as fontkit from "fontkit";

// Actually probe PingFangUI.ttc to see (a) what subfonts it contains and
// (b) whether each can resolve a Han glyph (e.g. 漢 U+6F22). The earlier
// DM-382 conclusion was that fontkit "returns null" — verify directly.

const path = "/System/Library/PrivateFrameworks/FontServices.framework/Versions/A/Resources/Reserved/PingFangUI.ttc";
const SAMPLE_CP = 0x6F22; // 漢

const ttc = fontkit.openSync(path);
console.log(`TTC type: ${ttc.constructor?.name ?? typeof ttc}`);
if (ttc.fonts) {
  console.log(`Subfonts: ${ttc.fonts.length}`);
  for (let i = 0; i < ttc.fonts.length; i++) {
    const f = ttc.fonts[i];
    if (i > 0 && i !== 20 && i !== 24) continue; // focus on .PingFangUITextSC-Default[0], PingFangSC-Medium[20], .PingFangSC-Medium[24]
    console.log(`\n[${i}] ${f.postscriptName}`);
    console.log(`  numGlyphs=${f.numGlyphs} unitsPerEm=${f.unitsPerEm}`);
    // List tables present
    try { console.log(`  tables: ${Object.keys(f._directory?.tables ?? {}).join(",")}`); } catch (e) {}
    // Check cmap explicitly
    try {
      const cm = f.cmap;
      console.log(`  cmap: present=${!!cm} subtables=${cm?.subtables?.length ?? "?"}`);
      if (cm?.subtables) for (const st of cm.subtables) console.log(`    subtable platformID=${st.platformID} encodingID=${st.encodingID} format=${st.format ?? st.version ?? "?"}`);
    } catch (e) { console.log(`  cmap THROW: ${e.message}`); }
    // glyphForCodePoint
    try {
      const g = f.glyphForCodePoint(SAMPLE_CP);
      console.log(`  glyphForCodePoint(0x${SAMPLE_CP.toString(16)}): ${g ? `id=${g.id} adv=${g.advanceWidth} bboxW=${g.bbox?.maxX - g.bbox?.minX}` : "null"}`);
    } catch (e) { console.log(`  glyphForCodePoint THROW: ${e.message}`); }
    // Try direct getGlyph by id
    try {
      const g100 = f.getGlyph(100);
      console.log(`  getGlyph(100): id=${g100?.id} adv=${g100?.advanceWidth} bbox=${JSON.stringify(g100?.bbox ?? null)} pathOps=${g100?.path?.commands?.length ?? "?"}`);
    } catch (e) { console.log(`  getGlyph(100) THROW: ${e.message}`); }
    try {
      const g500 = f.getGlyph(500);
      console.log(`  getGlyph(500): adv=${g500?.advanceWidth} pathOps=${g500?.path?.commands?.length ?? "?"}`);
    } catch (e) { console.log(`  getGlyph(500) THROW: ${e.message}`); }
    // Try layout-with-feature path
    try {
      const r = f.layout("漢");
      console.log(`  layout("漢"): ${r.glyphs.length} glyphs, [0]=id=${r.glyphs[0]?.id} adv=${r.glyphs[0]?.advanceWidth}`);
    } catch (e) { console.log(`  layout THROW: ${e.message}`); }
    continue;
  }
} else if (typeof ttc.glyphForCodePoint === "function") {
  console.log("Single font (not a collection):");
  console.log(`  postscriptName=${ttc.postscriptName} family="${ttc.familyName}" subfamily="${ttc.subfamilyName}" numGlyphs=${ttc.numGlyphs} unitsPerEm=${ttc.unitsPerEm}`);
  const g = ttc.glyphForCodePoint(SAMPLE_CP);
  console.log(`  glyph for U+${SAMPLE_CP.toString(16)}: ${g ? `id=${g.id} adv=${g.advanceWidth}` : "null"}`);
} else {
  console.log("Unknown shape:", Object.keys(ttc));
}
