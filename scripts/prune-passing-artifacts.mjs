#!/usr/bin/env node
// DM-1216: shrink a suite output dir before uploading it as a CI artifact —
// keep results.json + index.html, but delete the expected/actual/diff PNGs for
// PASSING fixtures (a full 818-fixture shard would otherwise upload ~hundreds of
// mostly-empty diff PNGs). Failing fixtures keep their triplet for review.
//
// Usage: node scripts/prune-passing-artifacts.mjs <output-dir>

import { readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (dir == null) { console.error("prune-passing-artifacts: <output-dir> required"); process.exit(2); }

const resultsPath = join(dir, "results.json");
if (!existsSync(resultsPath)) { console.error(`prune-passing-artifacts: no results.json in ${dir}`); process.exit(1); }

const results = JSON.parse(readFileSync(resultsPath, "utf8"));
// A fixture's PNGs are written as `<flatName>-{expected,actual,diff}.png` where
// flatName is the fixture name (already `/`→`-` flattened in results.json).
const keep = new Set();
for (const r of results) {
  if (r && r.name && (!r.pass || r.skipped)) {
    for (const kind of ["expected", "actual", "diff"]) keep.add(`${r.name}-${kind}.png`);
  }
}

let removed = 0;
for (const name of readdirSync(dir)) {
  if (!name.endsWith(".png")) continue; // leave results.json / index.html / meta
  if (!keep.has(name)) { rmSync(join(dir, name), { force: true }); removed++; }
}
console.log(`prune-passing-artifacts: kept ${keep.size} PNGs for failing fixtures, removed ${removed} from ${dir}`);
