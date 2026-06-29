// DM-1424 — refine the win32 calibration output (runs on the HOST via tsx).
//
// The probe (probe-1424-win32-mapchars-vs-chromium.mjs) ran on the VM and recorded, per sampled cp,
// Chromium's painted family vs DirectWrite MapCharacters' pick. The only cps the
// live resolver actually FIRES on are those the static win32 chain misses — for
// every other cp the static chain wins and the resolver never runs, so a
// MapCharacters/Chromium difference there is irrelevant.
//
// win32FallbackChain() is pure routing logic (block predicates + the generated
// per-block table; no font-file reads), so we can evaluate it on darwin to learn
// which divergent cps the static table already routes (→ resolver never fires →
// harmless) vs which it misses (→ resolver fires → the cp that actually matters
// for the flip).

import { readFileSync } from "node:fs";
import { win32FallbackChain } from "../src/render/font-resolution.ts";

const IN = process.env.IN ?? "tools/scratch/win32-calib.json";
const data = JSON.parse(readFileSync(IN, "utf-8"));

function staticRoutes(hex: string): string[] {
  return win32FallbackChain(parseInt(hex, 16));
}

function annotate(entry: { hex: string }) {
  const chain = staticRoutes(entry.hex);
  return { ...entry, staticChain: chain, staticMisses: chain.length === 0 };
}

const diverge = (data.diverge ?? []).map(annotate);
const resolverTofu = (data.resolverTofu ?? []).map(annotate);

// The fidelity-relevant subset: cps the static table misses (resolver fires).
const divergeFires = diverge.filter((d: any) => d.staticMisses);
const tofuFires = resolverTofu.filter((d: any) => d.staticMisses);

console.log("=== DM-1424 win32 calibration refine ===");
console.log(`sampled=${data.sampled} uniqueCps=${data.uniqueCps}`);
console.log(JSON.stringify(data.summary, null, 2));
console.log();
console.log(`diverge total=${diverge.length}  of which static-MISSES (resolver fires)=${divergeFires.length}`);
console.log(`resolverTofu total=${resolverTofu.length}  of which static-MISSES (resolver fires)=${tofuFires.length}`);

console.log("\n--- Divergences where the static chain MISSES (resolver fires; genuine) ---");
for (const d of divergeFires) console.log(`  U+${d.hex.toUpperCase().padStart(4,"0")} ${JSON.stringify(d.ch)}  chromium=${d.chromium}  mapChars=${d.mapChars}  static=[]`);
if (!divergeFires.length) console.log("  (none)");

console.log("\n--- Resolver-tofu where the static chain MISSES (resolver fires; potential regression) ---");
for (const d of tofuFires) console.log(`  U+${d.hex.toUpperCase().padStart(4,"0")} ${JSON.stringify(d.ch)}  chromium=${d.chromium}  static=[]`);
if (!tofuFires.length) console.log("  (none)");

// Divergences where the static table OWNS the cp — resolver never fires, harmless.
console.log("\n--- Divergences where the static chain OWNS the cp (resolver never fires; harmless) ---");
const ownedByFam = new Map<string, number>();
for (const d of diverge) if (!d.staticMisses) ownedByFam.set(`${d.chromium}=>${d.mapChars}`, (ownedByFam.get(`${d.chromium}=>${d.mapChars}`) ?? 0) + 1);
for (const [k, c] of [...ownedByFam.entries()].sort((a,b)=>b[1]-a[1])) console.log(`  ${String(c).padStart(4)}  ${k}`);
