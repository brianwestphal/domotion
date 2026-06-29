// In-container: read the per-block sweep json, collect every distinct painted
// family, resolve each to its on-disk file + postscriptname via fc-match, and
// write a familyToPath map. Lets the host-side genroutes map block→family→path
// without a hand-maintained hundreds-entry table (the Noto profile has a
// script-specific family per block).
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const IN = process.env.SWEEP_IN ?? "/out/unicode-fonts.noto-linux.json";
const OUT = process.env.FAM2PATH_OUT ?? "/out/family-to-path.noto-linux.json";

const data = JSON.parse(readFileSync(IN, "utf-8"));
const families = new Set();
for (const fams of Object.values(data.blockToFamilies)) for (const f of fams) families.add(f);

const map = {};
for (const fam of families) {
  if (fam === "Noto Color Emoji") { map[fam] = null; continue; } // raster path
  try {
    const out = execFileSync("fc-match", ["-f", "%{file}\t%{postscriptname}\t%{family}", fam], { encoding: "utf-8" }).trim();
    const [file, psn, gotFamily] = out.split("\t");
    map[fam] = { file, postscriptName: psn || undefined, resolvedFamily: gotFamily };
  } catch { map[fam] = null; }
}
writeFileSync(OUT, JSON.stringify(map, null, 2));
console.error(`resolved ${Object.keys(map).length} families -> paths`);
// flag families whose fc-match resolved to a DIFFERENT family (name mismatch)
for (const [fam, v] of Object.entries(map)) {
  if (v && v.resolvedFamily && !v.resolvedFamily.split(",").includes(fam)) {
    console.error(`  MISMATCH: CDP "${fam}" -> fc-match "${v.resolvedFamily}" (${v.file})`);
  }
}
