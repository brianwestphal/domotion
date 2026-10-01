import { readFileSync } from "node:fs";
import { z } from "zod";
import { outcomeSchema, reportEnvelopeSchema, writeReport } from "./lib/report.js";
import type { AnimatedImageTruthRunReport } from "./animated-image-owner-resource-truth-schema.js";

export const TRUTH_RUN_TOOL = "animated-image-owner-resource-truth-collector";
export const TRUTH_ADJUDICATION_TOOL = "animated-image-owner-resource-truth-adjudicator";

const runDataSchema = z
  .object({
    schemaVersion: z.literal(1),
    ticket: z.literal("DM-2583"),
    stage: z.literal("animated-image-owner-resource-truth"),
    operatingSystem: z.enum(["macOS", "Linux", "Windows"]),
    evidenceRole: z.enum(["proposal", "validation"]),
    rows: z.array(z.unknown()),
    normalizedLogicalSha256: z.string(),
  })
  .passthrough();
const adjudicationDataSchema = z
  .object({
    schemaVersion: z.literal(1),
    ticket: z.literal("DM-2583"),
    stage: z.literal("animated-image-owner-resource-truth-adjudication"),
    inputs: z.array(z.object({ pathToken: z.string(), byteLength: z.number(), sha256: z.string() })),
    adjudication: z.object({
      schemaVersion: z.literal(1),
      ticket: z.literal("DM-2583"),
      requiredArtifactKeys: z.array(z.string()),
      normalizedLogicalSha256: z.string().nullable(),
      verdict: z.enum(["proposal-validation-agreement", "verdict-withheld"]),
      failures: z.array(z.string()),
    }),
    reportSha256: z.string(),
  })
  .passthrough();

function readVersionedData<T extends z.ZodRawShape>(
  path: string,
  schema: z.ZodObject<T>,
  tool: string,
): Record<string, unknown> {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  const enveloped = raw != null && typeof raw === "object" && ("tool" in raw || "data" in raw);
  if (enveloped) {
    const data = reportEnvelopeSchema(schema.extend({ outcome: outcomeSchema }), { tool, schemaVersion: 1 }).parse(raw)
      .data as Record<string, unknown>;
    const { outcome, ...logical } = data;
    const expectedOutcome =
      tool === TRUTH_RUN_TOOL ||
      (logical.adjudication as { verdict?: string } | undefined)?.verdict === "proposal-validation-agreement"
        ? "pass"
        : "fail";
    if (outcome !== expectedOutcome) throw new Error(`${tool} report outcome mismatch`);
    return logical;
  }
  return schema.parse(raw) as Record<string, unknown>;
}

export function readAnimatedImageTruthRun(path: string): AnimatedImageTruthRunReport {
  return readVersionedData(path, runDataSchema, TRUTH_RUN_TOOL) as unknown as AnimatedImageTruthRunReport;
}

export function readAnimatedImageTruthAdjudication(path: string): Record<string, unknown> {
  return readVersionedData(path, adjudicationDataSchema, TRUTH_ADJUDICATION_TOOL);
}

export function writeAnimatedImageTruthRun(path: string, report: AnimatedImageTruthRunReport, env = {}) {
  return writeReport(
    path,
    TRUTH_RUN_TOOL,
    { ...report, outcome: "pass" as const },
    { schemaVersion: 1, env, flag: "wx" },
  );
}

export function writeAnimatedImageTruthAdjudication(path: string, report: Record<string, unknown>, env = {}) {
  return writeReport(
    path,
    TRUTH_ADJUDICATION_TOOL,
    {
      ...report,
      outcome:
        report.adjudication != null &&
        (report.adjudication as { verdict?: string }).verdict === "proposal-validation-agreement"
          ? "pass"
          : "fail",
    },
    { schemaVersion: 1, env, flag: "wx" },
  );
}
