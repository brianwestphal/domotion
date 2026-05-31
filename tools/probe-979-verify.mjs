import * as fontkit from "fontkit";
const menlo = fontkit.openSync("/System/Library/Fonts/Menlo.ttc").getFont("Menlo-Regular");
const symbols = fontkit.openSync("/System/Library/Fonts/Apple Symbols.ttf");
const stix = fontkit.openSync("/System/Library/Fonts/Supplemental/STIXTwoMath.otf");
const cps = [0x2115, 0x211D, 0x2124];
for (const cp of cps) {
  for (const [name, f] of [["Menlo", menlo], ["Symbols", symbols], ["STIX", stix]]) {
    const g = f.glyphForCodePoint(cp);
    const layout = f.layout(String.fromCodePoint(cp));
    const adv = layout.positions[0].xAdvance * 32 / f.unitsPerEm;
    console.log(`U+${cp.toString(16).toUpperCase()}  ${name.padEnd(8)} glyphId=${g.id} width=${adv.toFixed(2)}`);
  }
  console.log();
}
