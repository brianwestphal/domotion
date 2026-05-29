import * as fontkit from "fontkit";
const fc = fontkit.openSync("/System/Library/Fonts/Apple Color Emoji.ttc");
console.log("Type:", fc.type, "fonts:", fc.fonts ? fc.fonts.length : 1);
if (fc.fonts) {
  for (const f of fc.fonts) console.log("  font:", f.fullName, f.postscriptName);
  const font = fc.getFont("AppleColorEmoji");
  if (font) {
    const sm = font.glyphForCodePoint(0x1F600);
    if (sm) {
      const scale = 48 / font.unitsPerEm;
      console.log("smiley advance:", sm.advanceWidth, "px:", sm.advanceWidth * scale);
      console.log("smiley bbox:", sm.bbox);
      console.log("smiley left bearing px:", sm.bbox.minX * scale);
      console.log("smiley bitmap path-bbox width px:", (sm.bbox.maxX - sm.bbox.minX) * scale);
    }
  }
}
