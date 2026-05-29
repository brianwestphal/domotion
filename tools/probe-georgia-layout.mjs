import * as fontkit from "fontkit";
const font = fontkit.openSync("/System/Library/Fonts/Supplemental/Georgia.ttf");
console.log("HELLO   :", font.layout("HELLO").glyphs.map(g => g.id));
console.log("hello   :", font.layout("hello").glyphs.map(g => g.id));
console.log("ELLO smcp:", font.layout("ELLO", ["smcp"]).glyphs.map(g => g.id));
console.log("ello smcp:", font.layout("ello", ["smcp"]).glyphs.map(g => g.id));
