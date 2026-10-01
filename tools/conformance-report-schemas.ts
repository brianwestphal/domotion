import { z } from "zod";
import { outcomeSchema, readReportData } from "./lib/report.js";

const fontLegacySchema = z
  .object({
    meta: z.object({ platform: z.string(), arch: z.string(), chromium: z.string() }).passthrough(),
    summary: z.object({ mismatchTotal: z.number().nonnegative(), comparisons: z.number().nonnegative() }).passthrough(),
  })
  .passthrough();
export const fontConformanceDataSchema = fontLegacySchema.extend({ outcome: outcomeSchema });
const fontCompatibleSchema = fontLegacySchema.transform((report) => ({
  ...report,
  outcome: report.summary.mismatchTotal === 0 ? ("pass" as const) : ("fail" as const),
}));

const shapingLegacySchema = z
  .object({
    meta: z.object({ platform: z.string(), chromium: z.string() }).passthrough(),
    summary: z.object({ mismatchTotal: z.number().nonnegative() }).passthrough(),
    mismatches: z.array(z.unknown()),
  })
  .passthrough();
export const shapingConformanceDataSchema = shapingLegacySchema.extend({ outcome: outcomeSchema });
const shapingCompatibleSchema = shapingLegacySchema.transform((report) => ({
  ...report,
  outcome: report.summary.mismatchTotal === 0 ? ("pass" as const) : ("fail" as const),
}));

const clusterLegacySchema = z
  .object({
    meta: z
      .object({
        agreed: z.number().nonnegative(),
        mismatched: z.number().nonnegative(),
        skipped: z.number().nonnegative(),
      })
      .passthrough(),
    results: z.array(z.object({ verdict: z.enum(["agree", "mismatch", "skip"]) }).passthrough()),
  })
  .passthrough();
export const clusterConformanceDataSchema = clusterLegacySchema.extend({ outcome: outcomeSchema });
const clusterCompatibleSchema = clusterLegacySchema.transform((report) => ({
  ...report,
  outcome:
    report.meta.mismatched > 0 ? ("fail" as const) : report.meta.agreed === 0 ? ("skip" as const) : ("pass" as const),
}));

const decorationRowSchema = z
  .object({
    transcription: z.object({ ok: z.boolean() }).passthrough(),
    svgGeometry: z.object({ ok: z.boolean() }).passthrough(),
    skipInk: z.object({ ok: z.boolean() }).passthrough().nullable().optional(),
  })
  .passthrough();
const decorationLegacySchema = z
  .object({
    platform: z.string(),
    architecture: z.string(),
    coordinateOwnership: z.object({ source: z.string() }).passthrough(),
    gates: z.object({ transcription: z.boolean(), skipInk: z.boolean(), svgGeometry: z.boolean() }).passthrough(),
    results: z.array(decorationRowSchema),
  })
  .passthrough();
export const decorationDataSchema = decorationLegacySchema.extend({ outcome: outcomeSchema });
const decorationCompatibleSchema = decorationLegacySchema.transform((report) => ({
  ...report,
  outcome: report.results.every(
    (row) =>
      row.transcription.ok &&
      (!report.gates.svgGeometry || row.svgGeometry.ok) &&
      (!report.gates.skipInk || row.skipInk == null || row.skipInk.ok),
  )
    ? ("pass" as const)
    : ("fail" as const),
}));

export function readFontConformanceReport(path: string) {
  return readReportData(path, fontConformanceDataSchema, {
    tool: "font-conformance",
    schemaVersion: 1,
    legacySchema: fontCompatibleSchema,
  });
}

export function readShapingConformanceReport(path: string) {
  return readReportData(path, shapingConformanceDataSchema, {
    tool: "shaping-conformance",
    schemaVersion: 1,
    legacySchema: shapingCompatibleSchema,
  });
}

export function readClusterConformanceReport(path: string) {
  return readReportData(path, clusterConformanceDataSchema, {
    tool: "cluster-conformance",
    schemaVersion: 1,
    legacySchema: clusterCompatibleSchema,
  });
}

export function readDecorationReport(path: string) {
  return readReportData(path, decorationDataSchema, {
    tool: "decoration-oracle",
    schemaVersion: 1,
    legacySchema: decorationCompatibleSchema,
  });
}
