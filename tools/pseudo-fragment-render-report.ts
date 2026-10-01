import { z } from "zod";
import { outcomeSchema, readReportData } from "./lib/report.js";
import type { PseudoRenderOracleReport } from "./pseudo-fragment-render-oracle.js";

export function pseudoFragmentRenderOutcome(report: Pick<PseudoRenderOracleReport, "verdict">): "pass" | "fail" {
  return report.verdict === "source-exact" ? "pass" : "fail";
}

const rowSchema = z.object({
  dpr: z.number().positive(),
  exactRecords: z.number().int().nonnegative(),
  terminalRecords: z.number().int().nonnegative(),
  terminalReasons: z.array(z.string()),
  renderedRecords: z.number().int().nonnegative(),
  sourceEdges: z.number().int().nonnegative(),
  renderedEdges: z.number().int().nonnegative(),
  maxEdgeDistanceDevicePixels: z.number().nonnegative(),
  unmatchedSourceEdges: z.number().int().nonnegative(),
  unmatchedRenderedEdges: z.number().int().nonnegative(),
  structuralErrors: z.array(z.string()),
  pass: z.boolean(),
});

const legacySchema = z.object({
  schemaVersion: z.literal(1),
  chromiumVersion: z.string(),
  platform: z.string(),
  architecture: z.string(),
  toleranceDevicePixels: z.literal(4),
  requiredStates: z.array(z.string()),
  rows: z.array(rowSchema),
  verdict: z.enum(["source-exact", "source-drift"]),
});

const dataSchema = legacySchema
  .extend({ outcome: outcomeSchema })
  .refine(
    (value) => value.outcome === pseudoFragmentRenderOutcome(value),
    "outcome must agree with the pseudo-fragment verdict",
  );

export function readPseudoFragmentRenderReport(path: string): z.infer<typeof dataSchema> {
  return readReportData(path, dataSchema, {
    tool: "pseudo-fragment-render-oracle",
    schemaVersion: 1,
    legacySchema: legacySchema.transform((report) => ({ ...report, outcome: pseudoFragmentRenderOutcome(report) })),
    legacySchemaVersion: 1,
  });
}
