import * as fontkit from "fontkit";
try {
  const ttc = fontkit.openSync("/System/Library/Fonts/Supplemental/Gurmukhi Sangam MN.ttc");
  console.log("Type:", ttc.constructor.name);
  if (ttc.fonts != null) {
    console.log("Fonts in collection:", ttc.fonts.length);
    for (const f of ttc.fonts) console.log("  -", f.postscriptName, "/", f.familyName);
  } else {
    console.log("Single font, postscriptName:", ttc.postscriptName);
    console.log("  numGlyphs:", ttc.numGlyphs);
    console.log("  unitsPerEm:", ttc.unitsPerEm);
  }
} catch(e) { console.error("Open failed:", e.message); }
