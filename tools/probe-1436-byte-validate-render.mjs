// DM-1436: prove a RENDER-side refactor is byte-identical. Loads every cached
// captured tree under tests/output/**/.expected-cache/*.json, renders each to
// SVG with a fixed size + a generation reset (so output is deterministic), and
// writes a {file: sha256(svg)} manifest. Run before a refactor (baseline) and
// after; any hash that changes means the SVG output changed.
//
//   npx tsx tools/probe-1436-byte-validate-render.mjs <out-manifest.json>
//
// Workflow for a render-side refactor: write a baseline manifest, refactor, write
// a second manifest, and diff — every entry must match (proves byte-identical
// SVG output across ~2.7k cached trees without a CI sweep).

import { readFileSync, readdirSync, writeFileSync, statSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { elementTreeToSvgInner } from "../src/render/element-tree-to-svg.ts";
import { resetGeneration } from "../src/render/text-to-path.ts";

const OUT = process.argv[2] ?? "tools/scratch/render-manifest.json";
const ROOT = "tests/output";

function findCaches(dir) {
  const out = [];
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) {
      if (name === ".expected-cache") {
        for (const f of readdirSync(p)) if (f.endsWith(".json")) out.push(join(p, f));
      } else {
        out.push(...findCaches(p));
      }
    }
  }
  return out;
}

const files = findCaches(ROOT).sort();
const manifest = {};
let ok = 0, skip = 0;
for (const f of files) {
  let data;
  try { data = JSON.parse(readFileSync(f, "utf8")); } catch { skip++; continue; }
  const tree = data.tree;
  if (!Array.isArray(tree)) { skip++; continue; }
  try {
    resetGeneration();
    const svg = elementTreeToSvgInner(tree, 1024, 768);
    manifest[f.replace(ROOT + "/", "")] = createHash("sha256").update(svg).digest("hex").slice(0, 16);
    ok++;
  } catch (e) {
    manifest[f.replace(ROOT + "/", "")] = `ERROR:${e.message}`;
    skip++;
  }
}
writeFileSync(OUT, JSON.stringify(manifest, null, 0));
console.error(`rendered ${ok} trees (${skip} skipped) → ${OUT}`);
