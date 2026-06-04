// DM-1083 A/B: diff two html-test-suite results.json files (OFF vs ON) by
// fixture name. Reports pass/fail transitions and per-fixture region-count /
// diffPct deltas, so a flag flip can be judged a net win without eyeballing 331
// tiles. Usage: node tools/ab-compare-results.mjs <off/results.json> <on/results.json>
import { readFileSync } from "node:fs";

const [offPath, onPath] = process.argv.slice(2);
if (!offPath || !onPath) { console.error("usage: ab-compare-results.mjs <off.json> <on.json>"); process.exit(1); }
const off = JSON.parse(readFileSync(offPath, "utf-8"));
const on = JSON.parse(readFileSync(onPath, "utf-8"));

const byName = (arr) => new Map(arr.map((r) => [r.name, r]));
const O = byName(off), N = byName(on);

const newlyPass = [], newlyFail = [], improved = [], regressed = [], unchanged = [];
let sumRegionDelta = 0, sumDiffDelta = 0;
for (const [name, o] of O) {
  const n = N.get(name);
  if (!n) continue;
  const dReg = (n.regionCount ?? 0) - (o.regionCount ?? 0);
  const dDiff = (n.diffPct ?? 0) - (o.diffPct ?? 0);
  sumRegionDelta += dReg; sumDiffDelta += dDiff;
  if (!o.pass && n.pass) newlyPass.push({ name, o, n });
  else if (o.pass && !n.pass) newlyFail.push({ name, o, n });
  else if (dReg < 0 || dDiff < -0.005) improved.push({ name, o, n, dReg, dDiff });
  else if (dReg > 0 || dDiff > 0.005) regressed.push({ name, o, n, dReg, dDiff });
  else unchanged.push(name);
}
const fmt = (e) => `${e.name.padEnd(52)} regions ${String(e.o.regionCount).padStart(3)}→${String(e.n.regionCount).padStart(3)}  diff ${e.o.diffPct.toFixed(3)}%→${e.n.diffPct.toFixed(3)}%`;

const offPassCount = off.filter((r) => r.pass).length;
const onPassCount = on.filter((r) => r.pass).length;
console.log(`\n=== DM-1083 A/B (${O.size} fixtures) ===`);
console.log(`Pass count:  OFF ${offPassCount}  →  ON ${onPassCount}   (${onPassCount - offPassCount >= 0 ? "+" : ""}${onPassCount - offPassCount})`);
console.log(`Σ region delta: ${sumRegionDelta >= 0 ? "+" : ""}${sumRegionDelta}    Σ diffPct delta: ${sumDiffDelta >= 0 ? "+" : ""}${sumDiffDelta.toFixed(3)}%`);
console.log(`\nNewly PASS (${newlyPass.length}):`);
for (const e of newlyPass) console.log("  ✅ " + fmt(e));
console.log(`\nNewly FAIL (${newlyFail.length}):`);
for (const e of newlyFail) console.log("  ❌ " + fmt(e));
console.log(`\nREGRESSED but still same pass-state (${regressed.length}):`);
for (const e of regressed.sort((a, b) => b.dReg - a.dReg)) console.log("  ⚠️  " + fmt(e));
console.log(`\nIMPROVED but still same pass-state (${improved.length}):`);
for (const e of improved.sort((a, b) => a.dReg - b.dReg).slice(0, 40)) console.log("  ▴ " + fmt(e));
if (improved.length > 40) console.log(`  … and ${improved.length - 40} more improved`);
console.log(`\nUnchanged: ${unchanged.length}`);
