import { z } from "zod";
import { stableDigest } from "./stable-digest.js";

export type ConformanceMode = "representative" | "exhaustive";
export interface SourceFingerprint {
  chromiumRevision: string;
  chromiumHarfBuzzRevision: string;
  harfbuzzRevision: string;
  icuRevision: string;
  icuDataSha256: string;
  helperBinaries: Record<string, string>;
  generatedClassifiers: Record<string, string>;
}
export interface DecisionRow {
  id: string;
  property: string;
  input: string;
  output: unknown;
}
export interface SourceDriftEvidence {
  fingerprint: SourceFingerprint;
  mode: ConformanceMode;
  unicodeProperties: DecisionRow[];
  shapingDecisions: DecisionRow[];
}
const decisionRowSchema = z.object({ id: z.string(), property: z.string(), input: z.string(), output: z.unknown() });

/** Runtime shape of {@link SourceDriftEvidence}: the payload arrives from a JSON artifact. */
export const sourceDriftEvidenceSchema = z.object({
  fingerprint: z.object({
    chromiumRevision: z.string(),
    chromiumHarfBuzzRevision: z.string(),
    harfbuzzRevision: z.string(),
    icuRevision: z.string(),
    icuDataSha256: z.string(),
    helperBinaries: z.record(z.string(), z.string()),
    generatedClassifiers: z.record(z.string(), z.string()),
  }),
  mode: z.enum(["representative", "exhaustive"]),
  unicodeProperties: z.array(decisionRowSchema),
  shapingDecisions: z.array(decisionRowSchema),
});

export interface SourceDriftReview {
  sourceRefs: string[];
  updatedPropertyRows: string[];
  updatedShapingRows: string[];
}

const digest = stableDigest;
const complete = (value: unknown): boolean =>
  typeof value === "string"
    ? value.length > 0 && !["unknown", "unavailable", "missing"].includes(value)
    : value != null &&
      typeof value === "object" &&
      Object.keys(value as object).length > 0 &&
      Object.values(value as Record<string, unknown>).every(complete);
const rows = (items: DecisionRow[]): Map<string, string> => new Map(items.map((row) => [row.id, digest(row)]));
const changedRows = (before: DecisionRow[], after: DecisionRow[]): string[] => {
  const a = rows(before),
    b = rows(after);
  return [...new Set([...a.keys(), ...b.keys()])].filter((id) => a.get(id) !== b.get(id)).sort();
};

export interface SourceDriftVerdict {
  schemaVersion: 1;
  verdict: "comparable" | "verdict-withheld";
  rollChanged: boolean;
  unicodeChanges: string[];
  shapingChanges: string[];
  blockers: string[];
}

/** The withheld verdict for evidence that could not even be read. */
export function invalidSourceDriftVerdict(): SourceDriftVerdict {
  return {
    schemaVersion: 1,
    verdict: "verdict-withheld",
    rollChanged: false,
    unicodeChanges: [],
    shapingChanges: [],
    blockers: ["invalid-source-drift-payload"],
  };
}

/** Fail-closed adjudication for the ICU/HarfBuzz boundary Chromium consumes. */
export function compareSourceDrift(
  before: SourceDriftEvidence,
  after: SourceDriftEvidence,
  review?: SourceDriftReview,
): SourceDriftVerdict {
  const fingerprintComplete = complete(before.fingerprint) && complete(after.fingerprint);
  const profileComparable = before.mode === after.mode;
  const unicodeChanges = changedRows(before.unicodeProperties, after.unicodeProperties);
  const shapingChanges = changedRows(before.shapingDecisions, after.shapingDecisions);
  const rollChanged = digest(before.fingerprint) !== digest(after.fingerprint);
  const reviewed =
    review != null &&
    review.sourceRefs.length > 0 &&
    unicodeChanges.every((id) => review.updatedPropertyRows.includes(id)) &&
    shapingChanges.every((id) => review.updatedShapingRows.includes(id));
  const blockers = [
    ...(!fingerprintComplete ? ["incomplete-source-fingerprint"] : []),
    ...(!profileComparable ? ["incomparable-conformance-mode"] : []),
    ...(rollChanged && (unicodeChanges.length > 0 || shapingChanges.length > 0) && !reviewed
      ? ["changed-branches-require-source-review-and-updated-oracle-rows"]
      : []),
  ];
  return {
    schemaVersion: 1,
    verdict: blockers.length === 0 ? "comparable" : "verdict-withheld",
    rollChanged,
    unicodeChanges,
    shapingChanges,
    blockers,
  };
}
