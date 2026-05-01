import * as fontkit from "fontkit";

const candidates = [
  ["/System/Library/PrivateFrameworks/FontServices.framework/Versions/A/Resources/Reserved/PingFangUI.ttc"],
];
for (const [path] of candidates) {
  console.log(`\n=== ${path} ===`);
  try {
    const c = fontkit.openSync(path);
    if (c.fonts) {
      for (const f of c.fonts) {
        console.log(`  ${f.postscriptName} (familyName="${f.familyName}", subfamily="${f.subfamilyName}")`);
      }
    } else {
      console.log(`  (single font) ${c.postscriptName} family="${c.familyName}"`);
    }
  } catch (e) {
    console.log(`  ERROR: ${e.message}`);
  }
}
