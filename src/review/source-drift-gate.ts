import { createHash } from "node:crypto";

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
export interface DecisionRow { id: string; property: string; input: string; output: unknown }
export interface SourceDriftEvidence {
  fingerprint: SourceFingerprint;
  mode: ConformanceMode;
  unicodeProperties: DecisionRow[];
  shapingDecisions: DecisionRow[];
}
export interface SourceDriftReview {
  sourceRefs: string[];
  updatedPropertyRows: string[];
  updatedShapingRows: string[];
}

const stable = (value: unknown): unknown => Array.isArray(value)
  ? value.map(stable)
  : value != null && typeof value === "object"
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]))
    : value;
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
const complete = (value: unknown): boolean => typeof value === "string"
  ? value.length > 0 && !["unknown", "unavailable", "missing"].includes(value)
  : value != null && typeof value === "object" && Object.keys(value as object).length > 0 && Object.values(value as Record<string, unknown>).every(complete);
const rows = (items: DecisionRow[]): Map<string, string> => new Map(items.map((row) => [row.id, digest(row)]));
const changedRows = (before: DecisionRow[], after: DecisionRow[]): string[] => {
  const a = rows(before), b = rows(after);
  return [...new Set([...a.keys(), ...b.keys()])].filter((id) => a.get(id) !== b.get(id)).sort();
};

/** Fail-closed adjudication for the ICU/HarfBuzz boundary Chromium consumes. */
export function compareSourceDrift(before: SourceDriftEvidence, after: SourceDriftEvidence, review?: SourceDriftReview) {
  const fingerprintComplete = complete(before.fingerprint) && complete(after.fingerprint);
  const profileComparable = before.mode === after.mode;
  const unicodeChanges = changedRows(before.unicodeProperties, after.unicodeProperties);
  const shapingChanges = changedRows(before.shapingDecisions, after.shapingDecisions);
  const rollChanged = digest(before.fingerprint) !== digest(after.fingerprint);
  const reviewed = review != null && review.sourceRefs.length > 0
    && unicodeChanges.every((id) => review.updatedPropertyRows.includes(id))
    && shapingChanges.every((id) => review.updatedShapingRows.includes(id));
  const blockers = [
    ...(!fingerprintComplete ? ["incomplete-source-fingerprint"] : []),
    ...(!profileComparable ? ["incomparable-conformance-mode"] : []),
    ...(rollChanged && (unicodeChanges.length > 0 || shapingChanges.length > 0) && !reviewed ? ["changed-branches-require-source-review-and-updated-oracle-rows"] : []),
  ];
  return { schemaVersion: 1, verdict: blockers.length === 0 ? "comparable" : "verdict-withheld", rollChanged, unicodeChanges, shapingChanges, blockers };
}
