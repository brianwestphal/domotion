import * as fontkit from "fontkit";
import { isMain, parseCommand, runMain } from "./lib/cli.mjs";

async function main(argv) {
  const { positionals } = parseCommand(argv, {});
  if (positionals.length !== 1) throw new Error("expected one JSON font probe argument");
  const [path, psn, startHex, endHex] = JSON.parse(positionals[0]);
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
  return 0;
}

if (isMain(import.meta.url)) await runMain(() => main(process.argv.slice(2)));
