import { stableDigest } from "./stable-digest.js";
import {
  compareSourceDrift,
  invalidSourceDriftVerdict,
  sourceDriftEvidenceFromReport,
  type SourceDriftReview,
  type SourceDriftVerdict,
} from "./source-drift-gate.js";
export interface RollArtifact {
  environmentFingerprint: Record<string, unknown>;
  reports: Array<{ area: string; status: string }>;
  reportPayloads?: Record<string, unknown>;
  visuals?: Record<string, { digest: string }>;
}
export interface RollReview {
  reviewedAreas: Record<
    string,
    {
      sourceRefs: string[];
      updatedRows: string[];
      classification: "upstream-drift" | "domotion-regression" | "no-semantic-change";
    }
  >;
  sourceDrift?: SourceDriftReview;
}
const digest = stableDigest;
function comparable(env: Record<string, unknown>): Record<string, unknown> {
  const c = structuredClone(env) as Record<string, unknown>;
  delete c.fingerprint;
  const r = c.runtimes as Record<string, unknown> | undefined;
  if (r) for (const k of ["chromiumSource", "harfbuzzSource", "skiaPinned", "icuSource"]) delete r[k];
  const b = c.chromium as Record<string, unknown> | undefined;
  if (b) delete b.version;
  return c;
}
export interface RollComparison {
  schemaVersion: 1;
  environmentComparable: boolean;
  stageChanges: Array<{ area: string; oldDigest: string; newDigest: string }>;
  visualChanges: Array<{ id: string; oldDigest: string | undefined; newDigest: string | undefined }>;
  missingReviews: string[];
  sourceDrift: SourceDriftVerdict | undefined;
  pass: boolean;
}

export function compareRollArtifacts(oldRun: RollArtifact, newRun: RollArtifact, review?: RollReview): RollComparison {
  const environmentComparable =
    digest(comparable(oldRun.environmentFingerprint)) === digest(comparable(newRun.environmentFingerprint));
  const areas = [...new Set([...oldRun.reports.map((r) => r.area), ...newRun.reports.map((r) => r.area)])].sort();
  const stageChanges = areas.flatMap((area) => {
    const a = oldRun.reportPayloads?.[area] ?? oldRun.reports.find((r) => r.area === area);
    const b = newRun.reportPayloads?.[area] ?? newRun.reports.find((r) => r.area === area);
    const oldValue = area === "icu-harfbuzz-source-drift" ? (sourceDriftEvidenceFromReport(a) ?? a) : a;
    const newValue = area === "icu-harfbuzz-source-drift" ? (sourceDriftEvidenceFromReport(b) ?? b) : b;
    return digest(oldValue) === digest(newValue)
      ? []
      : [{ area, oldDigest: digest(oldValue), newDigest: digest(newValue) }];
  });
  const ids = [...new Set([...Object.keys(oldRun.visuals ?? {}), ...Object.keys(newRun.visuals ?? {})])].sort();
  const visualChanges = ids
    .filter((id) => oldRun.visuals?.[id]?.digest !== newRun.visuals?.[id]?.digest)
    .map((id) => ({ id, oldDigest: oldRun.visuals?.[id]?.digest, newDigest: newRun.visuals?.[id]?.digest }));
  const missingReviews = stageChanges
    .map((x) => x.area)
    .filter((area) => {
      if (area === "icu-harfbuzz-source-drift") return false;
      const x = review?.reviewedAreas[area];
      return (
        !x || x.sourceRefs.length === 0 || (x.classification !== "no-semantic-change" && x.updatedRows.length === 0)
      );
    });
  const oldRaw = oldRun.reportPayloads?.["icu-harfbuzz-source-drift"];
  const newRaw = newRun.reportPayloads?.["icu-harfbuzz-source-drift"];
  const sourcePayloadMismatch = (oldRaw == null) !== (newRaw == null);
  // The payloads come from JSON artifacts, so they are validated rather than cast: a malformed one
  // withholds the verdict (fail closed) instead of throwing a TypeError out of the comparator.
  let sourceDrift: SourceDriftVerdict | undefined;
  if (oldRaw != null && newRaw != null) {
    const before = sourceDriftEvidenceFromReport(oldRaw);
    const after = sourceDriftEvidenceFromReport(newRaw);
    sourceDrift =
      before != null && after != null
        ? compareSourceDrift(before, after, review?.sourceDrift)
        : invalidSourceDriftVerdict();
  }
  const sourceComparable = !sourcePayloadMismatch && (sourceDrift == null || sourceDrift.verdict === "comparable");
  return {
    schemaVersion: 1,
    environmentComparable,
    stageChanges,
    visualChanges,
    missingReviews,
    sourceDrift,
    pass: environmentComparable && sourceComparable && missingReviews.length === 0,
  };
}
