#!/usr/bin/env tsx
/** DM-2530 strict Linux/Windows background-clip:text evidence aggregator. */
import { readFileSync } from "node:fs";
import type { BackgroundClipTextOracleReport } from "./background-clip-text-oracle.js";

export function adjudicateBackgroundClipTextNativeReports(reports: BackgroundClipTextOracleReport[]): string[] {
  const errors: string[] = [];
  const expected = new Set<NodeJS.Platform>(["linux", "win32"]);
  if (reports.length !== 2) errors.push(`expected 2 native reports, received ${reports.length}`);
  for (const report of reports) {
    if (!expected.delete(report.platform)) errors.push(`unexpected or duplicate platform ${report.platform}`);
    if (report.schemaVersion !== 2) errors.push(`${report.platform}: schema must be 2`);
    if (report.verdict !== "source-exact") errors.push(`${report.platform}: verdict ${report.verdict}`);
    if (report.chromiumExecutableSha256.length !== 64) errors.push(`${report.platform}: Chromium binary is not authenticated`);
    if (report.rows.map((row) => row.dpr).join(",") !== "1,2") errors.push(`${report.platform}: DPR1/2 evidence is incomplete`);
    if (!Object.values(report.logicalControls).every(Boolean)) errors.push(`${report.platform}: logical ownership/control failure`);
    if (report.paintedFonts.length !== 8) errors.push(`${report.platform}: painted font evidence is incomplete`);
    if (report.rows.some((row) => !row.pass)) errors.push(`${report.platform}: terminal source-edge classification failed`);
  }
  for (const platform of expected) errors.push(`missing ${platform} report`);
  return errors;
}

function main(): void {
  const paths = process.argv.slice(2);
  const reports = paths.map((path) => JSON.parse(readFileSync(path, "utf8")) as BackgroundClipTextOracleReport);
  const errors = adjudicateBackgroundClipTextNativeReports(reports);
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, reports: reports.length, errors, verdict: errors.length === 0 ? "source-exact" : "source-drift" }, null, 2)}\n`);
  if (errors.length > 0) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) main();
