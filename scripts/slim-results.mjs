#!/usr/bin/env node
// DM-1662: write a SLIM copy of each merged results-<os>.json for the review UI.
// The full record carries a `regions` array (per-connected-component rects —
// hundreds on a dense diff) that makes the merged unicode metadata ~290 MB. The
// review UI (tests/review-server.tsx `loadManifest`) never reads `regions`; it
// uses the scalar summary (regionCount / coveragePct / verdict / diffPct / …).
// So we drop the heavy arrays and keep the scalars, cutting the metadata to
// ~1 MB — small enough for the review tool to fetch on demand.
//
// Input:  <dir>/results-<os>.json      (fat, merged)
// Output: <dir>/results-<os>.slim.json (scalars only, + `shard`)
//
// Usage: node scripts/slim-results.mjs <dir>
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (dir == null) { console.error("slim-results: <dir> required"); process.exit(2); }

// Heavy per-fixture fields the review UI does NOT need (drop these).
const DROP = new Set(["regions"]);

let files = 0;
for (const name of readdirSync(dir)) {
  const m = /^results-([a-z0-9]+)\.json$/i.exec(name);
  if (m == null) continue;
  let arr;
  try { arr = JSON.parse(readFileSync(join(dir, name), "utf8")); } catch { continue; }
  if (!Array.isArray(arr)) continue;
  const slim = arr.map((r) => {
    const out = {};
    for (const k of Object.keys(r)) {
      if (DROP.has(k)) continue;
      // `chunks` (real-world scroll) is kept but its own nested `regions` dropped.
      if (k === "chunks" && Array.isArray(r[k])) {
        out[k] = r[k].map((c) => { const cc = { ...c }; delete cc.regions; return cc; });
      } else {
        out[k] = r[k];
      }
    }
    return out;
  });
  const outName = `results-${m[1].toLowerCase()}.slim.json`;
  writeFileSync(join(dir, outName), JSON.stringify(slim));
  files++;
  console.log(`slim-results: ${name} (${arr.length} fixtures) -> ${outName}`);
}
if (files === 0) console.error(`slim-results: no results-<os>.json found under ${dir}`);
