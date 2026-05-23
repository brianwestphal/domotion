import * as fontkit from "fontkit";

const f = fontkit.openSync("/System/Library/Fonts/Supplemental/STIXTwoMath.otf");
const ff = f.fonts ? f.fonts[0] : f;
const upem = ff.unitsPerEm;

const codepoints = [
  { name: "(", cp: 0x0028 },
  { name: "𝑎 (math italic a)", cp: 0x1D44E },
  { name: "𝑏 (math italic b)", cp: 0x1D44F },
  { name: "𝑐 (math italic c)", cp: 0x1D450 },
  { name: "𝑑 (math italic d)", cp: 0x1D451 },
  { name: "a (ascii)", cp: 0x0061 },
  { name: "F", cp: 0x0046 },
];

const scale = 22 / upem;
console.log(`STIX Two Math, upem=${upem}, scale at 22px = ${scale.toFixed(5)}`);

for (const { name, cp } of codepoints) {
  const layout = ff.layout(String.fromCodePoint(cp));
  const g = layout.glyphs[0];
  if (!g) { console.log(`${name}: no glyph`); continue; }
  const b = g.bbox;
  console.log(`${name} (U+${cp.toString(16)}, glyph ${g.id}): bbox maxY=${b.maxY} minY=${b.minY}`);
  console.log(`   ink ascent at 22px = ${(b.maxY * scale).toFixed(2)}, descent = ${(-b.minY * scale).toFixed(2)}`);
}
