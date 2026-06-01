import * as fontkit from "fontkit";
const f = fontkit.openSync("/Library/Fonts/NotoSans-Regular.ttf");
console.log("NotoSans-Regular numGlyphs:", f.numGlyphs);
const cps = [0xA722,0xA723,0xA724,0xA72D,0xA72E,0xA72F,0xA730,0xA731];
for (const cp of cps) {
  const g = f.glyphForCodePoint(cp);
  console.log(`U+${cp.toString(16).toUpperCase()}: id=${g.id}${g.id===0?" (.notdef)":""}`);
}
