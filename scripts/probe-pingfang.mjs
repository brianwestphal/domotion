import * as fontkit from "fontkit";

console.log("=== ヒラギノ角ゴシック W3.ttc ===");
const c = fontkit.openSync("/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc");
if (c.fonts) {
  for (const f of c.fonts) console.log(`  ${f.postscriptName}  family="${f.familyName}"  subfamily="${f.subfamilyName}"`);
}
