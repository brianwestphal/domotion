import * as fontkit from "fontkit";
const fc = fontkit.openSync("/System/Library/Fonts/Apple Color Emoji.ttc");
for (const psName of ["AppleColorEmoji", ".AppleColorEmojiUI"]) {
  const font = fc.getFont(psName);
  if (!font) continue;
  const sm = font.glyphForCodePoint(0x1F600);
  if (!sm) continue;
  const scale = 48 / font.unitsPerEm;
  console.log(`${psName}: advance=${sm.advanceWidth} (${(sm.advanceWidth * scale).toFixed(1)}px), unitsPerEm=${font.unitsPerEm}, bbox=${JSON.stringify(sm.bbox)}, ascent=${font.ascent}, descent=${font.descent}`);
}
