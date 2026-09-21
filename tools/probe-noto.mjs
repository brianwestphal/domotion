import * as fontkit from "fontkit";
const f = fontkit.openSync("/Library/Fonts/NotoSans-Regular.ttf");
console.log("NotoSans-Regular numGlyphs:", f.numGlyphs);
const cps = [0xa722, 0xa723, 0xa724, 0xa72d, 0xa72e, 0xa72f, 0xa730, 0xa731];
for (const cp of cps) {
  const g = f.glyphForCodePoint(cp);
  console.log(`U+${cp.toString(16).toUpperCase()}: id=${g.id}${g.id === 0 ? " (.notdef)" : ""}`);
}
