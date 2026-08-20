export type StageEvidenceStatus = "passed" | "failed" | "missing";

export interface StageEvidenceReport {
  area: string;
  oracle: string;
  status: StageEvidenceStatus;
  passedRows?: number;
  totalRows?: number;
  reportFile?: string;
  note?: string;
}
export interface StageEvidenceRule {
  suites: string[];
  fixture?: string;
  transitionIds: string[];
  areas: string[];
}

export interface StageEvidenceManifest {
  schemaVersion: 1;
  generatedAt: string;
  sourceRevision: string;
  platform: string;
  environmentFingerprint: Record<string, unknown>;
  reports: StageEvidenceReport[];
  rules: StageEvidenceRule[];
}

export interface RelevantStageEvidence {
  transitionIds: string[];
  reports: StageEvidenceReport[];
}

/**
 * Resolve evidence by the semantic inventory's explicit fixture links. Pixel
 * scores are intentionally absent from this API: a larger diff must never be
 * allowed to manufacture a more confident logical-stage diagnosis.
 */
export function relevantStageEvidence(
  manifest: StageEvidenceManifest | undefined,
  suite: string,
  fixture: string,
): RelevantStageEvidence | undefined {
  if (manifest == null) return undefined;
  const rules = manifest.rules.filter((rule) =>
    rule.suites.includes(suite) && (rule.fixture == null || rule.fixture === fixture));
  if (rules.length === 0) return undefined;
  const transitionIds = [...new Set(rules.flatMap((rule) => rule.transitionIds))].sort();
  const areas = new Set(rules.flatMap((rule) => rule.areas));
  return {
    transitionIds,
    reports: manifest.reports.filter((report) => areas.has(report.area)),
  };
}
