#!/usr/bin/env tsx
/** DM-2530 strict Linux/Windows background-clip:text evidence aggregator. */
import { z } from "zod";
import { isMain, parseCommand, runMain } from "./lib/cli.js";
import { outcomeSchema, readReportData } from "./lib/report.js";

const legacyDataSchema = z
  .object({
    schemaVersion: z.literal(2),
    platform: z.string(),
    verdict: z.enum(["source-exact", "source-drift"]),
    chromiumExecutableSha256: z.string(),
    rows: z.array(z.object({ dpr: z.number(), pass: z.boolean() }).passthrough()),
    logicalControls: z.record(z.string(), z.boolean()),
    paintedFonts: z.array(z.unknown()),
  })
  .passthrough();
const reportDataSchema = legacyDataSchema
  .extend({ outcome: outcomeSchema })
  .refine((report) => report.outcome === (report.verdict === "source-exact" ? "pass" : "fail"), {
    message: "background clip outcome disagrees with verdict",
  });

export function readBackgroundClipTextNativeReport(path: string): z.infer<typeof reportDataSchema> {
  return readReportData(path, reportDataSchema, {
    tool: "background-clip-text-oracle",
    schemaVersion: 1,
    legacySchema: legacyDataSchema.transform((report) => ({
      ...report,
      outcome: report.verdict === "source-exact" ? ("pass" as const) : ("fail" as const),
    })),
    legacySchemaVersion: 2,
  });
}

export function adjudicateBackgroundClipTextNativeReports(reports: z.infer<typeof reportDataSchema>[]): string[] {
  const errors: string[] = [];
  const expected = new Set<NodeJS.Platform>(["linux", "win32"]);
  if (reports.length !== 2) errors.push(`expected 2 native reports, received ${reports.length}`);
  for (const report of reports) {
    if (!expected.delete(report.platform)) errors.push(`unexpected or duplicate platform ${report.platform}`);
    if (report.schemaVersion !== 2) errors.push(`${report.platform}: schema must be 2`);
    if (report.verdict !== "source-exact") errors.push(`${report.platform}: verdict ${report.verdict}`);
    if (report.chromiumExecutableSha256.length !== 64)
      errors.push(`${report.platform}: Chromium binary is not authenticated`);
    if (report.rows.map((row) => row.dpr).join(",") !== "1,2")
      errors.push(`${report.platform}: DPR1/2 evidence is incomplete`);
    if (!Object.values(report.logicalControls).every(Boolean))
      errors.push(`${report.platform}: logical ownership/control failure`);
    if (report.paintedFonts.length !== 8) errors.push(`${report.platform}: painted font evidence is incomplete`);
    if (report.rows.some((row) => !row.pass))
      errors.push(`${report.platform}: terminal source-edge classification failed`);
  }
  for (const platform of expected) errors.push(`missing ${platform} report`);
  return errors;
}

export function checkBackgroundClipTextNative(argv: string[]): number {
  const { positionals: paths } = parseCommand(argv, {});
  const reports = paths.map(readBackgroundClipTextNativeReport);
  const errors = adjudicateBackgroundClipTextNativeReports(reports);
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: 1, reports: reports.length, errors, verdict: errors.length === 0 ? "source-exact" : "source-drift" }, null, 2)}\n`,
  );
  return errors.length > 0 ? 1 : 0;
}

if (isMain(import.meta.url)) await runMain(() => checkBackgroundClipTextNative(process.argv.slice(2)));
