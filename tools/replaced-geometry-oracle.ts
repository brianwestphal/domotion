#!/usr/bin/env tsx

/**
 * Stable compatibility entry point for the expanded DM-2364 gate.
 *
 * Existing parity manifests and CI scripts name this file. Keep that public
 * path while the source-heavy producer remains isolated and independently
 * importable for focused browser tests.
 */
export {
  REPLACED_OWNERSHIP_REQUIREMENTS,
  runReplacedOwnershipGate,
  runReplacedOwnershipTransitionOracle as runReplacedGeometryOracle,
  type ReplacedOwnershipGateReport,
  type ReplacedOwnershipRunReport,
} from "./replaced-ownership-transition-oracle.js";

import { writeFileSync } from "node:fs";
import { flag, isMain, parseFlags, runMain } from "./lib/cli.js";
import { runReplacedOwnershipGate } from "./replaced-ownership-transition-oracle.js";

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const values = parseFlags(argv, { dpr: { type: "string" }, json: { type: "string" } });
  const dpr = flag(values, "--dpr");
  const dprs =
    dpr != null
      ? dpr
          .split(",")
          .map(Number)
          .filter((value) => Number.isFinite(value) && value > 0)
      : [1];
  const report = await runReplacedOwnershipGate(dprs);
  const json = flag(values, "--json");
  if (json != null) {
    writeFileSync(json, `${JSON.stringify(report, null, 2)}\n`);
  }
  for (const run of report.runs) {
    console.log(
      `replaced ownership oracle DPR${run.fingerprint.deviceScaleFactor}: ${run.adjudication.passedRows}/${run.adjudication.totalRows}`,
    );
    for (const error of run.adjudication.errors) console.log(`FAIL DPR${run.fingerprint.deviceScaleFactor} ${error}`);
  }
  if (report.verdict !== "source-exact") process.exitCode = 1;
}

if (isMain(import.meta.url)) await runMain(() => main());
