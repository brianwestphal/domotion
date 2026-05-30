
import * as fontkit from "fontkit";
const [path, psn, startHex, endHex] = JSON.parse(process.argv[2]);
const f = fontkit.openSync(path);
const font = psn != null && f.getFont != null ? f.getFont(psn) : f;
const start = parseInt(startHex, 16);
const end = parseInt(endHex, 16);
// Probe EVERY codepoint in the range. Some macOS Sangam MN fonts have
// GSUB tables that fontkit's parser blows up on for SPECIFIC codepoints
// (e.g. U+0A01 in Gurmukhi crashes with "invalid array length" in
// ArrayPrototypeSplice). Skipping codepoints — even sampling per 1/16 —
// can miss the crashers, so walk the whole block. The probe runs once
// per font in the generator; runtime cost is amortised over many sweeps.
for (let cp = start; cp <= end; cp++) {
  font.layout(String.fromCodePoint(cp));
}
console.log("OK");
