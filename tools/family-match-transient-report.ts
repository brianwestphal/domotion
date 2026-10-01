/** Validated transient reports; committed environment-keyed baselines stay flat. */
import { z } from "zod";
import { outcomeSchema, readReportData, writeReport, type Outcome } from "./lib/report.js";

const missSchema = z.strictObject({ family: z.string(), css: z.number(), chrome: z.string(), ours: z.string() });
const macLegacySchema = z.strictObject({
  scored: z.number().int(),
  agree: z.number().int(),
  skipped: z.number().int(),
  misses: z.array(missSchema),
});
const platformLegacySchema = z.strictObject({
  meta: z.strictObject({
    suite: z.literal("family-match"),
    os: z.enum(["linux", "windows"]),
    capturedAt: z.iso.datetime({ offset: true }),
    env: z.record(z.string(), z.union([z.string(), z.number()])),
    weights: z.array(z.number()),
  }),
  summary: z.strictObject({
    families: z.number().int(),
    cases: z.number().int(),
    scored: z.number().int(),
    agree: z.number().int(),
    rejectAgree: z.number().int(),
    skipped: z.number().int(),
    misses: z.number().int(),
  }),
  misses: z.array(missSchema),
});

export const macFamilyMatchDataSchema = macLegacySchema.extend({ outcome: outcomeSchema });
export const platformFamilyMatchDataSchema = platformLegacySchema.extend({ outcome: outcomeSchema });

export type FamilyMatchTool =
  "family-match-conformance" | "family-match-conformance-linux" | "family-match-conformance-win32";

export function writeFamilyMatchTransientReport<T extends object>(
  path: string,
  tool: FamilyMatchTool,
  report: T,
  outcome: Outcome,
  env: Record<string, unknown>,
): void {
  writeReport(path, tool, { ...report, outcome }, { schemaVersion: 1, env });
}

/** Old flat files have no adjudicated verdict; mark their outcome unknown. */
export function readFamilyMatchTransientReport(path: string, tool: FamilyMatchTool) {
  if (tool === "family-match-conformance") {
    return readReportData(path, macFamilyMatchDataSchema, {
      tool,
      schemaVersion: 1,
      legacySchema: macLegacySchema.transform((report) => ({ ...report, outcome: "skip" as const })),
    });
  }
  const os = tool === "family-match-conformance-linux" ? "linux" : "windows";
  const dataSchema = platformFamilyMatchDataSchema.refine((report) => report.meta.os === os);
  return readReportData(path, dataSchema, {
    tool,
    schemaVersion: 1,
    legacySchema: platformLegacySchema
      .refine((report) => report.meta.os === os)
      .transform((report) => ({ ...report, outcome: "skip" as const })),
  });
}
