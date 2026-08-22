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
import { pathToFileURL } from "node:url";
import { runReplacedOwnershipGate } from "./replaced-ownership-transition-oracle.js";

async function main(): Promise<void> {
  const dprIndex = process.argv.indexOf("--dpr");
  const dprs = dprIndex >= 0 && process.argv[dprIndex + 1] != null
    ? process.argv[dprIndex + 1].split(",").map(Number).filter((value) => Number.isFinite(value) && value > 0)
    : [1];
  const report = await runReplacedOwnershipGate(dprs);
  const jsonIndex = process.argv.indexOf("--json");
  if (jsonIndex >= 0 && process.argv[jsonIndex + 1] != null) {
    writeFileSync(process.argv[jsonIndex + 1], `${JSON.stringify(report, null, 2)}\n`);
  }
  for (const run of report.runs) {
    console.log(`replaced ownership oracle DPR${run.fingerprint.deviceScaleFactor}: ${run.adjudication.passedRows}/${run.adjudication.totalRows}`);
    for (const error of run.adjudication.errors) console.log(`FAIL DPR${run.fingerprint.deviceScaleFactor} ${error}`);
  }
  if (report.verdict !== "source-exact") process.exitCode = 1;
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
