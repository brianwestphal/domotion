import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  BORDER_PHASE_SOURCE_PINS,
  borderPhaseGeometryStatus,
  buildPhaseCases,
  buildPhaseScenarios,
} from "../tools/border-phase-oracle.js";
import {
  adjudicateBorderPhaseReport,
  artifactSetFingerprint,
  readBorderPhaseOracleReport,
  type BorderPhaseEnvelope,
  type BorderPhaseReport,
  type RunEnvironment,
} from "../tools/border-phase-ratifier.js";
import { writeReport } from "../tools/lib/report.js";

const reportDirs: string[] = [];
afterEach(() => {
  for (const dir of reportDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("reads the legacy border-phase report and rejects unknown envelope versions", () => {
  const dir = mkdtempSync(join(tmpdir(), "domotion-border-report-"));
  reportDirs.push(dir);
  const path = join(dir, "nested", "report.json");
  const data = fixture().report;
  writeReport(path, "border-phase-oracle", { ...data, outcome: "pass" }, { schemaVersion: 1 });
  expect(readBorderPhaseOracleReport(path).corpusFingerprint).toBe("fixture-corpus");
  writeReport(path, "border-phase-oracle", { ...data, outcome: "pass" }, { schemaVersion: 3 });
  expect(() => readBorderPhaseOracleReport(path)).toThrow();
  writeFileSync(path, JSON.stringify(data));
  expect(readBorderPhaseOracleReport(path).scenarios).toHaveLength(9);
  writeFileSync(path, JSON.stringify({ ...data, schemaVersion: 4 }));
  expect(() => readBorderPhaseOracleReport(path)).toThrow();
});

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
        scenarios: Object.fromEntries(
          scenarios.map(({ id }) => [
            id,
            {
              edgeCeilingCssPx: 0.2,
              profileRmseCeiling: 0.2,
              observedWorstEdge: 0.1,
              observedWorstRmse: 0.1,
              repeatedMaxEdgeDelta: 0,
              repeatedMaxRmseDelta: 0,
            },
          ]),
        ),
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

// DM-132FV4: GitHub rolls runner images out gradually, so the ratifier accepts
// an unreviewed fingerprint only when the run's verified artifact set is
// byte-identical to the reviewed one. Every way around that must still drift.
describe("border phase ratifier runner-image rollouts (DM-132FV4)", () => {
  const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
  const rolledOut: RunEnvironment = { ...fingerprint, imageVersion: "20261030.0001.1", osRelease: "25.7.0" };

  /** Writes real artifact files, points the report at them, and reviews that artifact set. */
  function uploadedFixture() {
    const { report, baseline } = fixture();
    const dir = mkdtempSync(join(tmpdir(), "domotion-border-artifacts-"));
    reportDirs.push(dir);
    for (const scenario of report.scenarios) {
      const scenarioDir = join(dir, scenario.scenario.id);
      mkdirSync(scenarioDir);
      for (const [name, key] of [
        ["html.png", "htmlPngSha256"],
        ["domotion.svg", "svgSha256"],
        ["svg-img.png", "svgPngSha256"],
      ] as const) {
        const content = `${name}:${scenario.scenario.id}`;
        writeFileSync(join(scenarioDir, name), content);
        scenario.artifacts[key] = sha256(content);
      }
    }
    const reviewed = artifactSetFingerprint(report);
    baseline.platforms.darwin.evidence.repeatedArtifactSetSha256 = [reviewed, reviewed];
    report.meta.osRelease = rolledOut.osRelease;
    return { report, baseline, dir };
  }

  it("accepts an unreviewed image whose verified artifact set equals the reviewed set", () => {
    const { report, baseline, dir } = uploadedFixture();
    const result = adjudicateBorderPhaseReport(report, baseline, rolledOut, dir);
    expect(result.verdict).toBe("ratified-source-exact");
    expect(result.findings).toEqual([]);
    expect(result.fingerprint).toEqual({
      status: "artifact-set-match",
      drift: [
        "report osRelease fingerprint drift: 25.7.0 != 25.5.0",
        "runner imageVersion fingerprint drift: 20261030.0001.1 != 20260728.0273.1",
        "runner osRelease fingerprint drift: 25.7.0 != 25.5.0",
      ],
    });
  });

  it("reports the pinned image as reviewed", () => {
    const { report, baseline, dir } = uploadedFixture();
    report.meta.osRelease = fingerprint.osRelease;
    const result = adjudicateBorderPhaseReport(report, baseline, fingerprint, dir);
    expect(result.verdict).toBe("ratified-source-exact");
    expect(result.fingerprint).toEqual({ status: "reviewed", drift: [] });
  });

  it("drifts when an unreviewed image changes any artifact", () => {
    const { report, baseline, dir } = uploadedFixture();
    const scenario = report.scenarios[0];
    const content = "a different native paint";
    writeFileSync(join(dir, scenario.scenario.id, "html.png"), content);
    scenario.artifacts.htmlPngSha256 = sha256(content);
    const result = adjudicateBorderPhaseReport(report, baseline, rolledOut, dir);
    expect(result.verdict).toBe("drift");
    expect(result.fingerprint.status).toBe("drift");
    expect(result.findings).toContain("runner imageVersion fingerprint drift: 20261030.0001.1 != 20260728.0273.1");
  });

  it("drifts when the reported hashes are not backed by the uploaded files", () => {
    const { report, baseline, dir } = uploadedFixture();
    const scenarioId = report.scenarios[0].scenario.id;
    writeFileSync(join(dir, scenarioId, "domotion.svg"), "tampered");
    const result = adjudicateBorderPhaseReport(report, baseline, rolledOut, dir);
    expect(result.verdict).toBe("drift");
    expect(result.findings).toContain(`${scenarioId} domotion.svg hash mismatch`);
  });

  it("does not accept an unreviewed image without verifying the artifact files", () => {
    const { report, baseline } = uploadedFixture();
    const result = adjudicateBorderPhaseReport(report, baseline, rolledOut);
    expect(result.verdict).toBe("drift");
    expect(result.fingerprint.status).toBe("drift");
  });

  it("does not accept an unreviewed image against unstable reviewed evidence", () => {
    const { report, baseline, dir } = uploadedFixture();
    baseline.platforms.darwin.evidence.workflowRuns = [1];
    const result = adjudicateBorderPhaseReport(report, baseline, rolledOut, dir);
    expect(result.verdict).toBe("drift");
    expect(result.fingerprint.status).toBe("drift");
    expect(result.findings).toContain("darwin baseline lacks repeated stable artifact evidence");
  });

  it("still requires a runner fingerprint when the artifact set matches", () => {
    const { report, baseline, dir } = uploadedFixture();
    report.meta.osRelease = fingerprint.osRelease;
    const result = adjudicateBorderPhaseReport(report, baseline, undefined, dir);
    expect(result.verdict).toBe("drift");
    expect(result.findings).toContain("missing runner fingerprint");
  });
});

// DM-PPT418: doc 191 defines each ceiling as the observed maximum rounded up to
// an 8-bit alpha bucket plus one further quantization step (both written as
// 6-decimal values rounded up). Pin the reviewed baseline to that rule so a
// stale, looser ceiling cannot survive a later refresh of the observed maxima.
describe("border phase envelope ceilings (DM-PPT418)", () => {
  const ceil6 = (value: number) => Math.ceil(value * 1e6 - 1e-6) / 1e6;
  const ceilingFor = (observed: number) =>
    Number((ceil6(Math.ceil(observed * 255 - 1e-9) / 255) + ceil6(1 / 255)).toFixed(6));
  const baseline = JSON.parse(
    readFileSync("tests/baselines/border-phase-envelopes.json", "utf8"),
  ) as BorderPhaseEnvelope;

  it("derives every platform's ceilings from its observed maxima", () => {
    for (const [platform, envelope] of Object.entries(baseline.platforms)) {
      for (const [id, scenario] of Object.entries(envelope.scenarios)) {
        expect({ platform, id, edge: scenario.edgeCeilingCssPx, rmse: scenario.profileRmseCeiling }).toEqual({
          platform,
          id,
          edge: ceilingFor(scenario.observedWorstEdge),
          rmse: ceilingFor(scenario.observedWorstRmse),
        });
      }
    }
  });

  it("rejects the retired DSF 1 half-covered dotted-outline residual", () => {
    const { report, baseline: fixtureBaseline } = fixture();
    const envelope = fixtureBaseline.platforms.darwin.scenarios["dsf1.zoom1"];
    Object.assign(envelope, baseline.platforms.darwin.scenarios["dsf1.zoom1"]);
    const scenario = report.scenarios.find(({ scenario: { id } }) => id === "dsf1.zoom1")!;
    scenario.rows.find((row) => borderPhaseGeometryStatus(row) === "source-exact")!.outerError = 128 / 255;
    scenario.ratifiedPaintResiduals.worstEdge = 128 / 255;
    const result = adjudicateBorderPhaseReport(report, fixtureBaseline, fingerprint);
    expect(result.verdict).toBe("drift");
    expect(result.findings).toContain(`dsf1.zoom1 ratified edge ${128 / 255} > 0.003922`);
  });
});
