/** Versioned persistence for SFNS evidence; domain digests cover only `data` without outcome. */
import { z } from "zod";
import { outcomeSchema, reportEnvelopeSchema, writeReport } from "./lib/report.js";
import type { SfnsOracleArtifact } from "./sfns-mask-baseline-schema.js";
import type { SfnsPinnedSkiaProposalArtifact } from "./sfns-pinned-skia-mask-schema.js";
import type { SfnsPinnedChromiumValidationArtifact } from "./sfns-pinned-chromium-validation-schema.js";
import type { SfnsTerminalMaskAdjudicationReport } from "./sfns-terminal-mask-adjudicator.js";

export const SFNS_OUTLINE_TOOL = "sfns-mask-baseline-oracle";
export const SFNS_SKIA_TOOL = "sfns-pinned-skia-mask-collector";
export const SFNS_CHROMIUM_TOOL = "sfns-pinned-chromium-validation-collector";
export const SFNS_TERMINAL_TOOL = "sfns-terminal-mask-adjudicator";

const outlineSchema = z
  .object({
    schemaVersion: z.literal(2),
    authority: z.literal("diagnostic-only"),
    arm: z.enum(["proposal", "validation"]),
    observationId: z.string(),
    logicalDigest: z.string(),
    environment: z.object({ platform: z.literal("darwin") }).passthrough(),
    rows: z.array(z.unknown()),
    classifications: z.array(z.unknown()),
    mutationControlMoved: z.boolean(),
  })
  .passthrough();
const skiaSchema = z
  .object({
    schemaVersion: z.literal(2),
    authority: z.literal("proposal-private-pinned-skia"),
    arm: z.literal("proposal"),
    artifactDigest: z.string(),
    scenarios: z.array(z.unknown()),
    controls: z.array(z.unknown()),
  })
  .passthrough();
const chromiumSchema = z
  .object({
    schemaVersion: z.literal(2),
    authority: z.literal("validation-test-only-pinned-chromium"),
    arm: z.literal("validation"),
    artifactDigest: z.string(),
    scenarios: z.array(z.unknown()),
    controls: z.array(z.unknown()),
  })
  .passthrough();
const terminalSchema = z
  .object({
    schemaVersion: z.literal(3),
    authority: z.literal("exact-cross-arm-adjudication"),
    ready: z.boolean(),
    reportDigest: z.string(),
    inputs: z.object({ proposal: z.unknown(), validation: z.unknown() }),
    inputIntegrityErrors: z.array(z.string()),
    mismatches: z.array(z.unknown()),
  })
  .passthrough();

function parseData<T extends z.ZodRawShape>(
  bytes: Uint8Array,
  schema: z.ZodObject<T>,
  tool: string,
  expectedOutcome?: "pass" | "fail" | ((data: Record<string, unknown>) => "pass" | "fail"),
): Record<string, unknown> {
  const raw: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
  if (raw != null && typeof raw === "object" && ("tool" in raw || "data" in raw)) {
    const data = reportEnvelopeSchema(schema.extend({ outcome: outcomeSchema }), { tool, schemaVersion: 1 }).parse(raw)
      .data as Record<string, unknown>;
    const { outcome, ...logical } = data;
    const expected = typeof expectedOutcome === "function" ? expectedOutcome(logical) : expectedOutcome;
    if (expected != null && outcome !== expected) throw new Error(`${tool} outcome mismatch`);
    return logical;
  }
  return schema.parse(raw) as Record<string, unknown>;
}

export function parseSfnsOutlineArtifact(bytes: Uint8Array): SfnsOracleArtifact {
  return parseData(bytes, outlineSchema, SFNS_OUTLINE_TOOL) as unknown as SfnsOracleArtifact;
}
export function parseSfnsSkiaProposal(bytes: Uint8Array): SfnsPinnedSkiaProposalArtifact {
  return parseData(bytes, skiaSchema, SFNS_SKIA_TOOL, "pass") as unknown as SfnsPinnedSkiaProposalArtifact;
}
export function parseSfnsChromiumValidation(bytes: Uint8Array): SfnsPinnedChromiumValidationArtifact {
  return parseData(
    bytes,
    chromiumSchema,
    SFNS_CHROMIUM_TOOL,
    "pass",
  ) as unknown as SfnsPinnedChromiumValidationArtifact;
}
export function parseSfnsTerminalReport(bytes: Uint8Array): SfnsTerminalMaskAdjudicationReport {
  return parseData(bytes, terminalSchema, SFNS_TERMINAL_TOOL, (data) =>
    data.ready === true ? "pass" : "fail",
  ) as unknown as SfnsTerminalMaskAdjudicationReport;
}

export function writeSfnsOutlineReport(path: string, report: SfnsOracleArtifact, passed: boolean): void {
  writeReport(path, SFNS_OUTLINE_TOOL, { ...report, outcome: passed ? "pass" : "fail" }, { schemaVersion: 1 });
}
export function writeSfnsSkiaProposal(path: string, report: SfnsPinnedSkiaProposalArtifact): void {
  writeReport(path, SFNS_SKIA_TOOL, { ...report, outcome: "pass" }, { schemaVersion: 1 });
}
export function writeSfnsChromiumValidation(path: string, report: SfnsPinnedChromiumValidationArtifact): void {
  writeReport(path, SFNS_CHROMIUM_TOOL, { ...report, outcome: "pass" }, { schemaVersion: 1 });
}
export function writeSfnsTerminalReport(path: string, report: SfnsTerminalMaskAdjudicationReport): void {
  writeReport(path, SFNS_TERMINAL_TOOL, { ...report, outcome: report.ready ? "pass" : "fail" }, { schemaVersion: 1 });
}
