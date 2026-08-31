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
  /** Fixture proof is narrower and therefore authoritative over reports that
   * only describe the suite as a whole. */
  scope: "suite-global" | "fixture";
  /** Suite-global reports retained for auditability after fixture proof wins. */
  supersededReports?: StageEvidenceReport[];
}

export interface FixtureScopedStageEvidence {
  transitionIds?: string[];
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
  fixtureEvidence?: FixtureScopedStageEvidence,
): RelevantStageEvidence | undefined {
  if (manifest == null) {
    return fixtureEvidence == null ? undefined : {
      transitionIds: [...new Set(fixtureEvidence.transitionIds ?? [])].sort(),
      reports: fixtureEvidence.reports,
      scope: "fixture",
    };
  }
  const rules = manifest.rules.filter((rule) =>
    rule.suites.includes(suite) && (rule.fixture == null || rule.fixture === fixture));
  if (rules.length === 0 && fixtureEvidence == null) return undefined;
  const transitionIds = [...new Set([
    ...rules.flatMap((rule) => rule.transitionIds),
    ...(fixtureEvidence?.transitionIds ?? []),
  ])].sort();
  const fixtureRules = rules.filter((rule) => rule.fixture === fixture);
  const globalRules = rules.filter((rule) => rule.fixture == null);
  const areas = new Set(rules.flatMap((rule) => rule.areas));
  const reports = manifest.reports.filter((report) => areas.has(report.area));
  if (fixtureEvidence != null) {
    const fixtureAreas = new Set(fixtureRules.flatMap((rule) => rule.areas));
    const exactReports = reports.filter((report) => fixtureAreas.has(report.area));
    const globalAreas = new Set(globalRules.flatMap((rule) => rule.areas));
    const supersededReports = reports.filter((report) => globalAreas.has(report.area) && !fixtureAreas.has(report.area));
    return {
      transitionIds,
      reports: [...exactReports, ...fixtureEvidence.reports],
      scope: "fixture",
      ...(supersededReports.length > 0 ? { supersededReports } : {}),
    };
  }
  return {
    transitionIds,
    reports,
    scope: fixtureRules.length > 0 ? "fixture" : "suite-global",
  };
}
