import * as fontkit from "fontkit";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const fontsToTest = [
  // [path, postscriptName, codepointHex, label]
  ["/System/Library/Fonts/Supplemental/Gurmukhi Sangam MN.ttc", "GurmukhiSangamMN", 0x0A01, "Gurmukhi"],
  ["/System/Library/Fonts/Supplemental/Tamil Sangam MN.ttc", "TamilSangamMN", 0x0B82, "Tamil"],
  ["/System/Library/Fonts/Supplemental/Khmer Sangam MN.ttf", null, 0x1780, "Khmer"],
  ["/System/Library/Fonts/Supplemental/Lao Sangam MN.ttf", null, 0x0E81, "Lao"],
  ["/System/Library/Fonts/Supplemental/Myanmar Sangam MN.ttc", "MyanmarSangamMN", 0x1000, "Myanmar"],
  ["/System/Library/Fonts/Supplemental/Malayalam Sangam MN.ttc", "MalayalamSangamMN", 0x0D02, "Malayalam"],
  ["/System/Library/Fonts/Supplemental/Oriya Sangam MN.ttc", "OriyaSangamMN", 0x0B05, "Oriya"],
  ["/System/Library/Fonts/Supplemental/Sinhala Sangam MN.ttc", "SinhalaSangamMN", 0x0D85, "Sinhala"],
  ["/System/Library/Fonts/Supplemental/Kannada Sangam MN.ttc", "KannadaSangamMN", 0x0C82, "Kannada"],
];

const probeScript = `
import * as fontkit from "fontkit";
const [path, psn, cpHex] = JSON.parse(process.argv[2]);
const f = fontkit.openSync(path);
const font = psn != null && f.getFont != null ? f.getFont(psn) : f;
const cp = parseInt(cpHex, 16);
font.layout(String.fromCodePoint(cp));
console.log("OK");
`;
writeFileSync("/tmp/_probe.mjs", probeScript);

for (const [path, psn, cp, label] of fontsToTest) {
  const r = spawnSync("node", ["/tmp/_probe.mjs", JSON.stringify([path, psn, cp.toString(16)])], { encoding: "utf8", timeout: 10000 });
  const ok = r.status === 0 && r.stdout.includes("OK");
  console.log(`${label.padEnd(12)} U+${cp.toString(16).toUpperCase().padStart(4, "0")}  ${ok ? "OK" : "CRASH"}  (${path.split("/").pop()})`);
}
