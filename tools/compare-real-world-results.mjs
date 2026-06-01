// Compare two real-world `results.json` snapshots and print per-fixture
// diff. Used to evaluate the DM-1016 swap (capture before screenshot).
import { readFileSync } from "node:fs";

const baselinePath = process.argv[2] ?? "/tmp/baseline-results.json";
const newPath = process.argv[3] ?? "tests/output/real-world/results.json";

const baseline = JSON.parse(readFileSync(baselinePath, "utf-8")).results;
const updated = JSON.parse(readFileSync(newPath, "utf-8")).results;

const byName = (arr) => Object.fromEntries(arr.map((r) => [r.name, r]));
const a = byName(baseline);
const b = byName(updated);

const verdictRank = { clean: 0, trivial: 1, minor: 2, moderate: 3, major: 4 };
const results = [];
for (const name of Object.keys({ ...a, ...b })) {
  const x = a[name];
  const y = b[name];
  results.push({
    name,
    bCov: x?.coveragePct ?? null,
    aCov: y?.coveragePct ?? null,
    bRegions: x?.regionCount ?? null,
    aRegions: y?.regionCount ?? null,
    bVerdict: x?.verdict ?? "missing",
    aVerdict: y?.verdict ?? "missing",
  });
}

results.sort((a, b) => (b.aCov ?? 0) - (a.aCov ?? 0));

console.log("Per-fixture comparison (sorted by NEW coverage% desc):");
console.log("name".padEnd(50) + " | baseline → new      | regions  | verdict");
console.log("-".repeat(105));
let improvedCount = 0, worseCount = 0, sameCount = 0;
let baseTotal = 0, newTotal = 0;
for (const r of results) {
  const bStr = r.bCov != null ? `${r.bCov.toFixed(2)}%` : "—";
  const aStr = r.aCov != null ? `${r.aCov.toFixed(2)}%` : "—";
  const regStr = `${r.bRegions ?? "—"} → ${r.aRegions ?? "—"}`;
  const vStr = `${r.bVerdict} → ${r.aVerdict}`;
  const delta = (r.aCov ?? 0) - (r.bCov ?? 0);
  const marker = delta < -0.05 ? "✓" : delta > 0.05 ? "✗" : " ";
  if (delta < -0.05) improvedCount++;
  else if (delta > 0.05) worseCount++;
  else sameCount++;
  if (r.bCov != null) baseTotal += r.bCov;
  if (r.aCov != null) newTotal += r.aCov;
  console.log(`${marker} ${r.name.padEnd(48)} | ${bStr.padStart(7)} → ${aStr.padStart(7)} | ${regStr.padEnd(8)} | ${vStr}`);
}
console.log();
console.log(`Summary: ${improvedCount} improved, ${worseCount} worse (>0.05pp), ${sameCount} same`);
console.log(`Total coverage% sum: baseline=${baseTotal.toFixed(2)} → new=${newTotal.toFixed(2)}  (delta ${(newTotal - baseTotal).toFixed(2)})`);
