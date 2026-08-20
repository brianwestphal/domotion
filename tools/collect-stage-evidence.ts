#!/usr/bin/env tsx
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const outIndex = process.argv.indexOf("--out");
const out = resolve(outIndex >= 0 && process.argv[outIndex + 1] != null ? process.argv[outIndex + 1] : "stage-evidence");
mkdirSync(out, { recursive: true });
const tsx = resolve("node_modules/.bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
const runs: Array<[string, string]> = [
  ["shaping-clusters-glyphs", "tools/unified-shaping-oracle.ts"],
  ["renderer-font-route", "tools/renderer-font-route-oracle.ts"],
  ["text-layout-placement", "tools/layout-stage-oracle.ts"],
  ["text-decoration", "tools/decoration-oracle.ts"],
  ["borders-outlines", "tools/border-phase-oracle.ts"],
  ["gradients-masks-clips", "tools/paint-geometry-oracle.ts"],
  ["transforms-projection-reflection", "tools/transform-geometry-oracle.ts"],
  ["compositing-effects-paint-order", "tools/paint-order-oracle.ts"],
  ["replaced-elements-controls-generated-content", "tools/replaced-geometry-oracle.ts"],
  ["raster-fallback-boundary", "tools/raster-boundary-oracle.ts"],
];

for (const [area, tool] of runs) {
  const target = resolve(out, `${area}.json`);
  console.log(`\n[stage evidence] ${area} ← ${tool}`);
  const result = spawnSync(tsx, [tool, "--json", target], { stdio: "inherit", env: process.env, shell: process.platform === "win32" });
  if (result.status !== 0) console.warn(`[stage evidence] ${area} exited ${result.status ?? "without a status"}; retaining any report it wrote`);
  try {
    const report = JSON.parse(readFileSync(target, "utf8")) as Record<string, unknown>;
    writeFileSync(target, JSON.stringify({ ...report, evidenceOracle: tool, evidencePassed: result.status === 0 }, null, 2));
  } catch { /* explicit missing status in the manifest */ }
}

// Font selection must pass both instruments: the broad unified face/shaping
// report and the production-funnel route ledger. Keep the raw child reports in
// the composite so review never loses which boundary failed.
try {
  const unified = JSON.parse(readFileSync(resolve(out, "shaping-clusters-glyphs.json"), "utf8")) as Record<string, unknown>;
  const renderer = JSON.parse(readFileSync(resolve(out, "renderer-font-route.json"), "utf8")) as Record<string, unknown>;
  writeFileSync(resolve(out, "font-selection.json"), JSON.stringify({
    evidenceOracle: "tools/unified-shaping-oracle.ts + tools/renderer-font-route-oracle.ts",
    evidencePassed: unified.evidencePassed === true && renderer.evidencePassed === true,
    pairs: unified.pairs,
    records: unified.records,
    rendererRoute: renderer,
  }, null, 2));
} catch { /* explicit missing status in the manifest */ }
