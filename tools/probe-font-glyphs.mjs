// Check which on-disk fonts on macOS contain glyphs for the failing codepoints.
// Use fontkit (handles .ttc collections + variable fonts via openSync).
import * as fontkit from "fontkit";

const cases = [
  { name: "DM-1010 U+13668 (egypt ext-A)", cp: 0x13668 },
  { name: "DM-999  U+1D800 (signwriting)", cp: 0x1D800 },
  { name: "DM-998  U+1D80D (signwriting)", cp: 0x1D80D },
  { name: "DM-1012 U+3208E (CJK ext-H)",   cp: 0x3208E },
  { name: "DM-1011 U+305D6 (CJK ext-G)",   cp: 0x305D6 },
  { name: "DM-1000 U+2F8F5 (CJK compat)",  cp: 0x2F8F5 },
];

const PF_NEW = "/System/Library/PrivateFrameworks/FontServices.framework/Versions/A/Resources/Reserved/PingFangUI.ttc";
const fontsToCheck = [
  { path: PF_NEW, ps: "PingFangSC-Regular" },
  { path: PF_NEW, ps: "PingFangTC-Regular" },
  { path: PF_NEW, ps: "PingFangHK-Regular" },
  { path: PF_NEW, ps: "PingFangMO-Regular" },
  { path: PF_NEW, ps: ".PingFangSC-Regular" },
  { path: PF_NEW, ps: ".PingFangHK-Regular" },
  { path: "/System/Library/Fonts/Hiragino Sans GB.ttc", ps: "HiraginoSansGB-W3" },
  { path: "/System/Library/Fonts/SFCompact.ttf" },
  { path: "/System/Library/Fonts/LastResort.otf" },
  { path: "/System/Library/Fonts/Supplemental/Arial Unicode.ttf" },
  { path: "/Library/Fonts/NotoSansKR-Regular.otf" },
  { path: "/System/Library/Fonts/Supplemental/NotoSansEgyptianHieroglyphs-Regular.ttf" },
];

for (const { path, ps } of fontsToCheck) {
  let f;
  try { f = fontkit.openSync(path, ps); } catch (e) { console.log(`${path} ${ps ?? ""}: ${e.message}`); continue; }
  if (!f) { console.log(`${path} ${ps ?? ""}: openSync returned null`); continue; }
  console.log(`\n=== ${path} ${ps ?? ""} (${f.postscriptName}) ===`);
  for (const c of cases) {
    let glyphId = 0;
    try { glyphId = f.glyphForCodePoint(c.cp).id; } catch (e) { glyphId = -1; }
    console.log(`  ${c.name}: glyphId=${glyphId}${glyphId === 0 ? " (.notdef)" : ""}`);
  }
}
