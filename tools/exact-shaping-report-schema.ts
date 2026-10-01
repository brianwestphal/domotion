import { readFileSync } from "node:fs";
import { z } from "zod";
import { outcomeSchema, reportEnvelopeSchema } from "./lib/report.js";

const spanSchema = z.tuple([z.number(), z.number()]);
export const exactRecordSchema = z.object({
  environment: z.record(z.string(), z.unknown()),
  face: z.object({
    key: z.string(),
    path: z.string(),
    member: z.number(),
    postscriptName: z.string().nullable(),
    localPostscriptName: z.string().nullable(),
    namedInstance: z.string().nullable(),
    axes: z.record(z.string(), z.number()).nullable().default(null),
  }),
  input: z.object({
    text: z.string(),
    utf16Span: spanSchema,
    direction: z.enum(["ltr", "rtl", "ttb", "btt"]),
    fontSizePx: z.number(),
    script: z.string(),
    language: z.string(),
    features: z.array(z.string()),
    bufferFlags: z.number(),
    clusterLevel: z.number(),
  }),
  fallbackRuns: z.array(z.object({ utf16Span: spanSchema, face: z.string() })),
  glyphs: z.array(
    z.object({
      id: z.number(),
      cluster: z.number(),
      sourceSpan: spanSchema,
      xAdvance: z.number(),
      yAdvance: z.number(),
      xOffset: z.number(),
      yOffset: z.number(),
      flags: z.number(),
      unsafeToBreak: z.boolean(),
    }),
  ),
});

const exactSummarySchema = z
  .object({
    stage: z.literal("shaping"),
    verdict: z.enum(["exact-logical-agreement", "logical-mismatch", "verdict-withheld"]),
    completeEnvironment: z.boolean(),
    movementProven: z.boolean(),
    pairs: z.number().int().nonnegative(),
    controlHits: z.record(z.string(), z.number().int().nonnegative()),
    records: z.array(exactRecordSchema),
  })
  .passthrough();

export const exactShapingDataSchema = exactSummarySchema.extend({ outcome: outcomeSchema });
const legacyExactSchema = exactSummarySchema.extend({ schemaVersion: z.literal(3) });

export function readExactShapingReport(path: string): z.infer<typeof exactShapingDataSchema> {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (raw != null && typeof raw === "object" && "tool" in raw) {
    return reportEnvelopeSchema(exactShapingDataSchema, { tool: "exact-shaping-oracle", schemaVersion: 1 }).parse(raw)
      .data;
  }
  const legacy = legacyExactSchema.parse(raw);
  const { schemaVersion: _schemaVersion, ...data } = legacy;
  return exactShapingDataSchema.parse({
    ...data,
    outcome:
      data.verdict === "exact-logical-agreement" ? "pass" : data.verdict === "logical-mismatch" ? "fail" : "error",
  });
}
