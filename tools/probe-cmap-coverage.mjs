import * as fontkit from "fontkit";

// macOS CJK system fonts most likely to carry compatibility ideographs.
const candidates = [
  "/System/Library/Fonts/PingFang.ttc",
  "/System/Library/Fonts/Hiragino Sans GB.ttc",
  "/System/Library/Fonts/STHeiti Light.ttc",
  "/System/Library/Fonts/STHeiti Medium.ttc",
  "/Library/Fonts/Songti.ttc",
  "/System/Library/Fonts/Supplemental/Songti.ttc",
  "/System/Library/Fonts/Apple Symbols.ttf",
  "/System/Library/Fonts/Supplemental/PingFang.ttc",
];

function openAll(path) {
  try {
    const f = fontkit.openSync(path);
    return f.fonts ? f.fonts : [f];
  } catch {
    return [];
  }
}

const fonts = [];
for (const p of candidates) {
  for (const f of openAll(p)) fonts.push({ p, name: f.postscriptName ?? f.familyName, font: f });
}
console.log("Loaded faces:", fonts.map((f) => f.name).join(", "));

function coverage(cp) {
  const covering = [];
  for (const { name, font } of fonts) {
    try {
      const g = font.glyphForCodePoint(cp);
      if (g && g.id !== 0) covering.push(name);
    } catch {}
  }
  return covering;
}

function blockReport(label, lo, hi, gaps = []) {
  let covered = 0, total = 0;
  const sampleCovered = [], sampleUncovered = [];
  for (let cp = lo; cp <= hi; cp++) {
    total++;
    const cov = coverage(cp);
    if (cov.length > 0) {
      covered++;
      if (sampleCovered.length < 4) sampleCovered.push(`U+${cp.toString(16)}→[${cov[0]}]`);
    } else if (sampleUncovered.length < 4) {
      sampleUncovered.push(`U+${cp.toString(16)}`);
    }
  }
  console.log(`\n${label}: ${covered}/${total} literals covered by a macOS system font`);
  console.log("  sample covered:  ", sampleCovered.join("  "));
  console.log("  sample uncovered:", sampleUncovered.join("  ") || "(none)");
}

blockReport("F900–FAD9 (BMP CJK Compat Ideographs)", 0xF900, 0xFAD9);
blockReport("2F800–2FA1D (CJK Compat Ideographs Supplement)", 0x2F800, 0x2FA1D);
