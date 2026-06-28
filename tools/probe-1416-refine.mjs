// DM-1416 refine: for each divergence (Chromium family != fc-match :charset pick),
// determine REAL coverage via `fc-list :charset=<hex>` (fontconfig's own charset
// data — only lists fonts that actually contain the cp). Classify:
//   - noCover:   nothing covers cp → both Chromium and fc tofu → HARMLESS
//   - fcCovers:  fc-match's pick truly covers cp → the resolver WOULD register a
//                real glyph. Does it match what Chromium painted? (chromeCovers)
// Runs in-container (needs fc-list).
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const d = JSON.parse(readFileSync(process.env.IN ?? "/out/probe-1416.json", "utf-8"));
const OUT = process.env.OUT2 ?? "/out/probe-1416-refined.json";

const coverCache = new Map();
function coveringFamilies(hex) {
  if (coverCache.has(hex)) return coverCache.get(hex);
  let fams = [];
  try {
    const s = execFileSync("fc-list", [`:charset=${hex}`, "family"], { encoding: "utf-8" });
    fams = [...new Set(s.split("\n").map(l => l.split(",")[0].trim()).filter(Boolean))];
  } catch { fams = []; }
  coverCache.set(hex, fams);
  return fams;
}

const out = { harmlessNoCover: 0, fcCoversMatchesChrome: 0, fcCoversDiffChrome: 0, cases: [] };
for (const x of d.diverge) {
  const fams = coveringFamilies(x.hex);
  const fcCovers = fams.includes(x.fcBare);
  const chromeCovers = fams.includes(x.chromium);
  if (fams.length === 0) { out.harmlessNoCover++; continue; }
  if (!fcCovers) { out.harmlessNoCover++; continue; } // fc pick doesn't really cover → walker rejects → tofu
  // fc-match's pick truly covers cp.
  if (chromeCovers && x.chromium === x.fcBare) { out.fcCoversMatchesChrome++; continue; }
  // fc covers but with a different face than Chromium painted (and Chromium's face may or may not cover)
  out.fcCoversDiffChrome++;
  out.cases.push({ block: x.block, hex: x.hex, ch: x.ch, chromium: x.chromium, fcBare: x.fcBare, chromeCovers, covering: fams.slice(0, 6) });
}
writeFileSync(OUT, JSON.stringify(out, null, 2));
console.error(`harmlessNoCover=${out.harmlessNoCover}  fcCoversMatchesChrome=${out.fcCoversMatchesChrome}  fcCoversDiffChrome=${out.fcCoversDiffChrome}`);
// roll up the meaningful cases by (chromium -> fcBare)
const pair = new Map();
for (const c of out.cases) { const k = `${c.chromium} (covers=${c.chromeCovers})  =>  ${c.fcBare}`; pair.set(k, (pair.get(k) || 0) + 1); }
console.error("\nMeaningful fc-covers divergences by pair:");
for (const [k, n] of [...pair.entries()].sort((a, b) => b[1] - a[1])) console.error(String(n).padStart(5), k);
