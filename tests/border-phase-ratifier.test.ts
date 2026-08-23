import { describe, expect, it } from "vitest";

import {
  BORDER_PHASE_SOURCE_PINS,
  borderPhaseGeometryStatus,
  buildPhaseCases,
  buildPhaseScenarios,
} from "../tools/border-phase-oracle.js";
import {
  adjudicateBorderPhaseReport,
  artifactSetFingerprint,
  type BorderPhaseEnvelope,
  type BorderPhaseReport,
  type RunEnvironment,
} from "../tools/border-phase-ratifier.js";

const fingerprint: RunEnvironment = {
  image: "macos26-arm64",
  imageVersion: "20260728.0273.1",
  osRelease: "25.5.0",
  chromium: "147.0.7727.15",
  platform: "darwin",
  arch: "arm64",
  node: "v22.21.0",
};

function fixture(): { report: BorderPhaseReport; baseline: BorderPhaseEnvelope } {
  const cases = buildPhaseCases();
  const scenarios = buildPhaseScenarios([1, 2, 4], [0.8, 1, 1.25]);
  const report = {
    schemaVersion: 2,
    sourcePins: BORDER_PHASE_SOURCE_PINS,
    corpusFingerprint: "fixture-corpus",
    meta: {
      platform: "darwin",
      arch: "arm64",
      osRelease: "25.5.0",
      node: "v22.21.0",
      browserVersion: "147.0.7727.15",
      scenarios: scenarios.length,
      casesPerScenario: cases.length,
    },
    scenarios: scenarios.map((scenario) => ({
      scenario,
      geometry: {
        htmlSnapFits: [{ rule: "css-edge-round", mae: 0 }],
        svgSnapFits: [{ rule: "css-edge-round", mae: 0 }],
      },
      geometryOwnership: {
        ratifiedRows: 128,
        unratifiedRows: 0,
        unratifiedFamilies: [],
      },
      ratifiedPaintResiduals: { worstEdge: 0.1, worstRmse: 0.1, failed: [] },
      artifacts: {
        htmlPngSha256: `html-${scenario.id}`,
        svgSha256: `svg-${scenario.id}`,
        svgPngSha256: `rendered-${scenario.id}`,
      },
      rows: cases.map((phaseCase) => ({
        ...phaseCase,
        nominalCenter: phaseCase.nominalCenter * scenario.zoom,
        outerError: borderPhaseGeometryStatus(phaseCase) === "source-exact" ? 0.1 : 99,
        innerError: borderPhaseGeometryStatus(phaseCase) === "source-exact" ? 0.1 : 99,
        centerError: borderPhaseGeometryStatus(phaseCase) === "source-exact" ? 0.1 : 99,
        profileRmse: borderPhaseGeometryStatus(phaseCase) === "source-exact" ? 0.1 : 99,
      })),
    })),
  } satisfies BorderPhaseReport;
  const baseline = {
    schemaVersion: 1,
    corpusFingerprint: "fixture-corpus",
    sourcePins: BORDER_PHASE_SOURCE_PINS,
    requiredScenarioIds: scenarios.map(({ id }) => id),
    unratifiedFamilies: [],
    platforms: {
      darwin: {
        fingerprint,
        evidence: {
          workflowRuns: [1, 2],
          repeatedArtifactSetSha256: ["stable", "stable"],
        },
        scenarios: Object.fromEntries(scenarios.map(({ id }) => [id, {
          edgeCeilingCssPx: 0.2,
          profileRmseCeiling: 0.2,
          observedWorstEdge: 0.1,
          observedWorstRmse: 0.1,
          repeatedMaxEdgeDelta: 0,
          repeatedMaxRmseDelta: 0,
        }])),
      },
    },
  } satisfies BorderPhaseEnvelope;
  return { report, baseline };
}

describe("border phase ratifier", () => {
  it("ratifies all 128 source-owned rows, including uniform double borders", () => {
    const { report, baseline } = fixture();
    const result = adjudicateBorderPhaseReport(report, baseline, fingerprint);
    expect(result).toMatchObject({
      verdict: "ratified-source-exact",
      ratifiedRows: 1_152,
      unratifiedRows: 0,
      unratifiedFamilies: [],
      findings: [],
    });
    expect(result.artifactSetSha256).toBe(artifactSetFingerprint(report));
    expect(result.scenarios.every(({ pass }) => pass)).toBe(true);
  });

  it("rejects paint drift in a source-owned row", () => {
    const { report, baseline } = fixture();
    const scenario = report.scenarios[0];
    const row = scenario.rows.find((candidate) => borderPhaseGeometryStatus(candidate) === "source-exact")!;
    row.outerError = 0.25;
    scenario.ratifiedPaintResiduals.worstEdge = 0.25;
    const result = adjudicateBorderPhaseReport(report, baseline, fingerprint);
    expect(result.verdict).toBe("drift");
    expect(result.findings).toContain("dsf1.zoom0.8 ratified edge 0.25 > 0.2");
  });

  it("rejects the old unsnapped double-border geometry instead of hiding it in the envelope", () => {
    const { report, baseline } = fixture();
    const mutated = structuredClone(report);
    const scenario = mutated.scenarios[0];
    const double = scenario.rows.find(({ kind, style }) => kind === "border" && style === "double")!;
    double.outerError = 0.25;
    scenario.ratifiedPaintResiduals.worstEdge = 0.25;
    const mutation = adjudicateBorderPhaseReport(mutated, baseline, fingerprint);
    expect(mutation.verdict).toBe("drift");
    expect(mutation.findings).toContain(`${scenario.scenario.id} ratified edge 0.25 > 0.2`);
  });

  it("fails closed on runner or repeated-evidence fingerprint drift", () => {
    const { report, baseline } = fixture();
    const runnerDrift = adjudicateBorderPhaseReport(report, baseline, {
      ...fingerprint,
      imageVersion: "future-image",
    });
    expect(runnerDrift.verdict).toBe("drift");
    expect(runnerDrift.findings).toContain("runner imageVersion fingerprint drift: future-image != 20260728.0273.1");

    baseline.platforms.darwin.evidence.repeatedArtifactSetSha256[1] = "different";
    const evidenceDrift = adjudicateBorderPhaseReport(report, baseline, fingerprint);
    expect(evidenceDrift.verdict).toBe("drift");
    expect(evidenceDrift.findings).toContain("darwin baseline lacks repeated stable artifact evidence");
  });
});
