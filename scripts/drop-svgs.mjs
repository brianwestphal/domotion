#!/usr/bin/env node
// DM-1661: delete the generated *.svg files from a visual-test output dir before
// the CI artifact upload. The per-block unicode SVGs are ~2.4 MB each (~85% of
// the artifact weight) and the review UI only needs the expected/actual/diff
// PNGs — so the sharded review sweeps drop them by default (gate: the workflow's
// `include_svg` input) to keep the lazy-fetched shard downloads small.
//
// Usage: node scripts/drop-svgs.mjs <dir>   (cross-platform; runs on the Windows runner too)
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (dir == null) { console.error("drop-svgs: <dir> required"); process.exit(2); }
let n = 0;
try {
  for (const name of readdirSync(dir)) {
    if (name.endsWith(".svg")) { rmSync(join(dir, name), { force: true }); n++; }
  }
} catch (e) { console.error(`drop-svgs: ${e.message}`); process.exit(0); } // dir may not exist on an empty shard
console.log(`drop-svgs: removed ${n} .svg file(s) from ${dir}`);
