import { setRenderTextMode } from "../dist/render/text-to-path.js";

// Glyph-helper queries are oracle hooks on the engine's unstable ./testing entry.
const { createGlyphHelperFont, isGlyphHelperAvailable } = await import("@domotion/text-engine/testing");
console.log("helper available?", isGlyphHelperAvailable());

const helper = createGlyphHelperFont({
  postscriptName: "PingFangHK-Regular",
  fontPath: "/System/Library/Fonts/PingFang.ttc",
});
console.log("helper?", helper != null);
if (helper) {
  console.log("unitsPerEm:", helper.unitsPerEm);
  console.log("ascent:", helper.ascent);
  console.log("descent:", helper.descent);
  const cp = 0x305d6;
  const g = helper.glyphForCodePoint(cp);
  console.log(`glyphForCodePoint(U+305D6).id =`, g?.id);
  console.log("layout('𰗖'):");
  const r = helper.layout("𰗖");
  console.log("  glyphs:", r.glyphs.length);
  for (const g of r.glyphs) {
    console.log("    id=", g.id, "advance=", g.advanceWidth, "cmds=", g.path?.commands?.length ?? 0);
  }
}

// Try PingFangSC too
const sc = createGlyphHelperFont({
  postscriptName: "PingFangSC-Regular",
  fontPath: "/System/Library/Fonts/PingFang.ttc",
});
console.log("\n--- PingFangSC ---");
if (sc) {
  const r = sc.layout("𰗖");
  console.log("layout glyphs:", r.glyphs.length);
  for (const g of r.glyphs) {
    console.log("  id=", g.id, "adv=", g.advanceWidth, "cmds=", g.path?.commands?.length ?? 0);
  }
}
