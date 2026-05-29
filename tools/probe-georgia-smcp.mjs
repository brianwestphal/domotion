import * as fontkit from "fontkit";
const paths = [
  "/Library/Fonts/Georgia.ttf",
  "/System/Library/Fonts/Supplemental/Georgia.ttf",
];
let font = null;
for (const p of paths) {
  try { font = fontkit.openSync(p); console.log("opened:", p); break; } catch (e) {}
}
if (!font) { console.log("no Georgia"); process.exit(0); }
console.log("availableFeatures:", font.availableFeatures);
const a = font.layout("Hello");
const b = font.layout("Hello", ["smcp"]);
console.log("no features:", a.glyphs.map((g) => g.id));
console.log("with smcp:  ", b.glyphs.map((g) => g.id));
console.log("HellO advances no:  ", a.glyphs.map((g) => g.advanceWidth));
console.log("HellO advances smcp:", b.glyphs.map((g) => g.advanceWidth));
