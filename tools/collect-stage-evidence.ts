#!/usr/bin/env tsx
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { flag, isMain, parseFlags, runMain } from "./lib/cli.js";
import { outcomeSchema, reportEnvelopeSchema, writeReport } from "./lib/report.js";

const oracleDataSchema = z.object({ outcome: outcomeSchema }).passthrough();
const unifiedCompositeSchema = oracleDataSchema.extend({
  evidencePassed: z.boolean(),
  pairs: z.number().int().nonnegative(),
  records: z.array(z.unknown()),
});
const rendererCompositeSchema = oracleDataSchema.extend({ evidencePassed: z.boolean() });

export function annotateStageReport(path: string, toolPath: string, exitedSuccessfully: boolean) {
  const tool = basename(toolPath, ".ts");
  const report = reportEnvelopeSchema(oracleDataSchema, { tool, schemaVersion: 1 }).parse(
    JSON.parse(readFileSync(path, "utf8")),
  );
  const data = {
    ...report.data,
    evidenceOracle: toolPath,
    evidencePassed: exitedSuccessfully && report.data.outcome === "pass",
  };
  writeFileSync(path, `${JSON.stringify({ ...report, data }, null, 2)}\n`);
  return data;
}

export function writeFontSelectionComposite(out: string): void {
  const unified = reportEnvelopeSchema(unifiedCompositeSchema, {
    tool: "unified-shaping-oracle",
    schemaVersion: 1,
  }).parse(JSON.parse(readFileSync(resolve(out, "shaping-clusters-glyphs.json"), "utf8"))).data;
  const renderer = reportEnvelopeSchema(rendererCompositeSchema, {
    tool: "renderer-font-route-oracle",
    schemaVersion: 1,
  }).parse(JSON.parse(readFileSync(resolve(out, "renderer-font-route.json"), "utf8"))).data;
  writeReport(
    resolve(out, "font-selection.json"),
    "collect-stage-evidence",
    {
      outcome: unified.evidencePassed && renderer.evidencePassed ? "pass" : "fail",
      evidenceOracle: "tools/unified-shaping-oracle.ts + tools/renderer-font-route-oracle.ts",
      evidencePassed: unified.evidencePassed && renderer.evidencePassed,
      pairs: unified.pairs,
      records: unified.records,
      rendererRoute: renderer,
    },
    { schemaVersion: 1 },
  );
}

export function collectStageEvidence(argv: string[]): number {
  const values = parseFlags(argv, { out: { type: "string" } });
  const out = resolve(String(flag(values, "out", "stage-evidence")));
  mkdirSync(out, { recursive: true });
  const tsx = resolve("node_modules/.bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
  const oracleTimeoutMs = 180_000;
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
    const result = spawnSync(tsx, [tool, "--json", target], {
      stdio: "inherit",
      env: process.env,
      shell: process.platform === "win32",
      timeout: oracleTimeoutMs,
      killSignal: "SIGTERM",
    });
    const timedOut = result.error != null && "code" in result.error && result.error.code === "ETIMEDOUT";
    if (timedOut)
      console.warn(`[stage evidence] ${area} exceeded ${oracleTimeoutMs / 1000}s; retaining any report it wrote`);
    else if (result.error != null) console.warn(`[stage evidence] ${area} failed to run: ${result.error.message}`);
    else if (result.status !== 0)
      console.warn(
        `[stage evidence] ${area} exited ${result.status ?? "without a status"}; retaining any report it wrote`,
      );
    try {
      annotateStageReport(target, tool, result.status === 0);
    } catch {
      /* explicit missing status in the manifest */
    }
  }

  // Font selection must pass both instruments: the broad unified face/shaping
  // report and the production-funnel route ledger. Keep the raw child reports in
  // the composite so review never loses which boundary failed.
  try {
    writeFontSelectionComposite(out);
  } catch {
    /* explicit missing status in the manifest */
  }
  return 0;
}

if (isMain(import.meta.url)) await runMain(() => collectStageEvidence(process.argv.slice(2)));
