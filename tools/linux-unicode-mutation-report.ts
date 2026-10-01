import { z } from "zod";
import { outcomeSchema, readReportData } from "./lib/report.js";

const fixtureSchema = z
  .object({
    fixture: z.string(),
    verdict: z.enum(["raster-floor-candidate", "logical-mismatch", "mutation-inert", "incomplete"]),
  })
  .passthrough();

const matrixLegacySchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.iso.datetime({ offset: true }),
  corpus: z.string(),
  sourceAuthority: z.unknown(),
  fixtures: z.array(fixtureSchema),
  summary: z.object({
    total: z.number().int().nonnegative(),
    rasterFloorCandidates: z.number().int().nonnegative(),
    logicalMismatches: z.number().int().nonnegative(),
    mutationInert: z.number().int().nonnegative(),
    incomplete: z.number().int().nonnegative(),
  }),
  errors: z.array(z.string()),
});

const matrixDataSchema = matrixLegacySchema
  .extend({ outcome: outcomeSchema })
  .refine(
    (data) => data.outcome === (data.errors.length === 0 ? "pass" : "fail"),
    "matrix outcome must agree with errors",
  );

const candidatesLegacySchema = z.object({
  schemaVersion: z.literal(1),
  source: z.literal("linux-unicode-mutation-matrix.json"),
  fixtures: z.array(z.string()),
});

const candidatesDataSchema = candidatesLegacySchema.extend({ outcome: z.literal("skip") });

export function readLinuxUnicodeMutationMatrix(path: string): z.infer<typeof matrixDataSchema> {
  return readReportData(path, matrixDataSchema, {
    tool: "linux-unicode-mutation-matrix",
    schemaVersion: 1,
    legacySchema: matrixLegacySchema.transform((data) => ({
      ...data,
      outcome: data.errors.length === 0 ? ("pass" as const) : ("fail" as const),
    })),
    legacySchemaVersion: 1,
  });
}

export function readLinuxUnicodeRasterCandidates(path: string): z.infer<typeof candidatesDataSchema> {
  return readReportData(path, candidatesDataSchema, {
    tool: "linux-unicode-raster-candidates",
    schemaVersion: 1,
    legacySchema: candidatesLegacySchema.transform((data) => ({ ...data, outcome: "skip" as const })),
    legacySchemaVersion: 1,
  });
}
