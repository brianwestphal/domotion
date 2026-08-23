#!/usr/bin/env tsx
/** Strict adjudicator for the source-exact border phase matrix.
 *
 * The native producer intentionally reports every row. This gate applies a
 * reviewed, fingerprinted paint envelope only after every family has
 * source-owned reference-box geometry. A paint tolerance cannot substitute
 * for that logical ownership.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  BORDER_PHASE_SOURCE_PINS,
  borderPhaseGeometryStatus,
  buildPhaseCases,
  buildPhaseScenarios,
  type PhaseCase,
  type SnapFit,
} from "./border-phase-oracle.js";

interface PhaseRowReport extends PhaseCase {
  outerError: number;
  innerError: number;
  centerError: number;
  profileRmse: number;
}

interface ScenarioReport {
  scenario: { id: string; dsf: number; zoom: number };
  geometry: { htmlSnapFits: SnapFit[]; svgSnapFits: SnapFit[] };
  geometryOwnership: {
    ratifiedRows: number;
    unratifiedRows: number;
    unratifiedFamilies: string[];
  };
  ratifiedPaintResiduals: {
    worstEdge: number;
    worstRmse: number;
    failed: string[];
  };
  artifacts: {
    htmlPngSha256: string;
    svgSha256: string;
    svgPngSha256: string;
  };
  rows: PhaseRowReport[];
}

export interface BorderPhaseReport {
  schemaVersion: number;
  sourcePins: typeof BORDER_PHASE_SOURCE_PINS;
  corpusFingerprint: string;
  meta: {
    platform: string;
    arch: string;
    osRelease: string;
    node: string;
    browserVersion: string;
    scenarios: number;
    casesPerScenario: number;
  };
  scenarios: ScenarioReport[];
}

interface RunnerFingerprint {
  image: string;
  imageVersion: string;
  osRelease: string;
  chromium: string;
  platform: string;
  arch: string;
  node: string;
}

export interface BorderPhaseEnvelope {
  schemaVersion: number;
  corpusFingerprint: string;
  sourcePins: typeof BORDER_PHASE_SOURCE_PINS;
  requiredScenarioIds: string[];
  unratifiedFamilies: string[];
  platforms: Record<string, {
    fingerprint: RunnerFingerprint;
    evidence: {
      workflowRuns: number[];
      repeatedArtifactSetSha256: string[];
    };
    scenarios: Record<string, {
      edgeCeilingCssPx: number;
      profileRmseCeiling: number;
      observedWorstEdge: number;
      observedWorstRmse: number;
      repeatedMaxEdgeDelta: number;
      repeatedMaxRmseDelta: number;
    }>;
  }>;
}

export interface RunEnvironment extends RunnerFingerprint {
  fontInventory?: { digest?: string };
}

export interface BorderPhaseAdjudication {
  schemaVersion: 1;
  platform: string;
  verdict: "ratified-source-exact" | "drift";
  artifactSetSha256: string;
  ratifiedRows: number;
  unratifiedRows: number;
  unratifiedFamilies: string[];
  findings: string[];
  scenarios: Array<{
    id: string;
    ratifiedRows: number;
    unratifiedRows: number;
    worstEdge: number;
    edgeCeiling: number;
    worstRmse: number;
    rmseCeiling: number;
    pass: boolean;
  }>;
}

const sha256 = (value: Buffer | string): string =>
  createHash("sha256").update(value).digest("hex");

const stableArtifactSetHash = (scenario: ScenarioReport): string => sha256([
  scenario.scenario.id,
  scenario.artifacts.htmlPngSha256,
  scenario.artifacts.svgSha256,
  scenario.artifacts.svgPngSha256,
].join("\n"));

export function artifactSetFingerprint(report: BorderPhaseReport): string {
  return sha256(report.scenarios
    .slice()
    .sort((a, b) => a.scenario.id.localeCompare(b.scenario.id))
    .map(stableArtifactSetHash)
    .join("\n"));
}

function compareFingerprint(
  expected: RunnerFingerprint,
  actual: RunnerFingerprint,
  label: string,
  findings: string[],
): void {
  for (const key of ["image", "imageVersion", "osRelease", "chromium", "platform", "arch", "node"] as const) {
    if (actual[key] !== expected[key])
      findings.push(`${label} ${key} fingerprint drift: ${actual[key]} != ${expected[key]}`);
  }
}

function compareReportFingerprint(
  expected: RunnerFingerprint,
  actual: BorderPhaseReport["meta"],
  findings: string[],
): void {
  const values = {
    osRelease: actual.osRelease,
    chromium: actual.browserVersion,
    platform: actual.platform,
    arch: actual.arch,
    node: actual.node,
  };
  for (const key of ["osRelease", "chromium", "platform", "arch", "node"] as const) {
    if (values[key] !== expected[key])
      findings.push(`report ${key} fingerprint drift: ${values[key]} != ${expected[key]}`);
  }
}

function verifyArtifactHashes(
  scenario: ScenarioReport,
  artifactDir: string,
  findings: string[],
): void {
  const dir = join(artifactDir, scenario.scenario.id);
  const entries = [
    ["html.png", scenario.artifacts.htmlPngSha256],
    ["domotion.svg", scenario.artifacts.svgSha256],
    ["svg-img.png", scenario.artifacts.svgPngSha256],
  ] as const;
  for (const [name, expected] of entries) {
    const path = join(dir, name);
    if (!existsSync(path)) {
      findings.push(`${scenario.scenario.id} missing artifact ${name}`);
      continue;
    }
    const actual = sha256(readFileSync(path));
    if (actual !== expected)
      findings.push(`${scenario.scenario.id} ${name} hash mismatch`);
  }
}

export function adjudicateBorderPhaseReport(
  report: BorderPhaseReport,
  baseline: BorderPhaseEnvelope,
  runEnvironment?: RunEnvironment,
  artifactDir?: string,
): BorderPhaseAdjudication {
  const findings: string[] = [];
  const platformBaseline = baseline.platforms[report.meta.platform];
  if (report.schemaVersion !== 2) findings.push(`report schema ${report.schemaVersion} != 2`);
  if (baseline.schemaVersion !== 1) findings.push(`baseline schema ${baseline.schemaVersion} != 1`);
  if (report.corpusFingerprint !== baseline.corpusFingerprint)
    findings.push("corpus fingerprint drift");
  if (JSON.stringify(report.sourcePins) !== JSON.stringify(baseline.sourcePins)
      || JSON.stringify(report.sourcePins) !== JSON.stringify(BORDER_PHASE_SOURCE_PINS))
    findings.push("upstream source pin drift");
  if (platformBaseline == null) findings.push(`no ratified platform ${report.meta.platform}`);

  if (platformBaseline != null) {
    compareReportFingerprint(platformBaseline.fingerprint, report.meta, findings);
    if (runEnvironment == null) findings.push("missing runner fingerprint");
    else compareFingerprint(platformBaseline.fingerprint, runEnvironment, "runner", findings);
    if (platformBaseline.evidence.workflowRuns.length < 2
        || platformBaseline.evidence.repeatedArtifactSetSha256.length < 2
        || new Set(platformBaseline.evidence.repeatedArtifactSetSha256).size !== 1)
      findings.push(`${report.meta.platform} baseline lacks repeated stable artifact evidence`);
  }

  const expectedCases = buildPhaseCases();
  const expectedCasesById = new Map(expectedCases.map((phaseCase) => [phaseCase.id, phaseCase]));
  const expectedIds = new Set(expectedCases.map(({ id }) => id));
  const requiredScenarios = buildPhaseScenarios([1, 2, 4], [0.8, 1, 1.25]);
  const requiredScenarioIds = requiredScenarios.map(({ id }) => id);
  const requiredScenariosById = new Map(requiredScenarios.map((scenario) => [scenario.id, scenario]));
  if (report.meta.scenarios !== requiredScenarios.length)
    findings.push(`report scenario count ${report.meta.scenarios} != ${requiredScenarios.length}`);
  if (report.meta.casesPerScenario !== expectedCases.length)
    findings.push(`report case count ${report.meta.casesPerScenario} != ${expectedCases.length}`);
  if (JSON.stringify(baseline.requiredScenarioIds) !== JSON.stringify(requiredScenarioIds))
    findings.push("baseline scenario inventory drift");
  if (JSON.stringify(baseline.unratifiedFamilies) !== JSON.stringify([]))
    findings.push("baseline unratified-family inventory drift");

  const reportById = new Map(report.scenarios.map((scenario) => [scenario.scenario.id, scenario]));
  const scenarioResults: BorderPhaseAdjudication["scenarios"] = [];
  let ratifiedRows = 0;
  let unratifiedRows = 0;
  for (const id of requiredScenarioIds) {
    const scenario = reportById.get(id);
    const envelope = platformBaseline?.scenarios[id];
    if (scenario == null) {
      findings.push(`missing scenario ${id}`);
      continue;
    }
    const scenarioFindingsBefore = findings.length;
    const expectedScenario = requiredScenariosById.get(id)!;
    if (scenario.scenario.dsf !== expectedScenario.dsf || scenario.scenario.zoom !== expectedScenario.zoom)
      findings.push(`${id} scenario coordinates drift`);
    if (envelope == null) findings.push(`missing ${report.meta.platform} envelope for ${id}`);
    if (scenario.rows.length !== expectedIds.size)
      findings.push(`${id} has ${scenario.rows.length}/${expectedIds.size} rows`);
    const actualIds = new Set(scenario.rows.map(({ id: rowId }) => rowId));
    for (const expectedId of expectedIds)
      if (!actualIds.has(expectedId)) findings.push(`${id} missing row ${expectedId}`);
    for (const actualId of actualIds)
      if (!expectedIds.has(actualId)) findings.push(`${id} has unexpected row ${actualId}`);
    for (const row of scenario.rows) {
      const expected = expectedCasesById.get(row.id);
      if (expected == null) continue;
      const exactFields = ["kind", "style", "width", "phase", "x", "y", "boxWidth", "boxHeight"] as const;
      for (const field of exactFields) {
        if (row[field] !== expected[field])
          findings.push(`${id}/${row.id} ${field} corpus drift`);
      }
      if (Math.abs(row.nominalCenter - expected.nominalCenter * expectedScenario.zoom) > 1e-12)
        findings.push(`${id}/${row.id} nominalCenter corpus drift`);
    }

    const sourceExact = scenario.rows.filter((row) => borderPhaseGeometryStatus(row) === "source-exact");
    const unratified = scenario.rows.filter((row) => borderPhaseGeometryStatus(row) !== "source-exact");
    ratifiedRows += sourceExact.length;
    unratifiedRows += unratified.length;
    if (sourceExact.length !== 128 || unratified.length !== 0)
      findings.push(`${id} ownership split ${sourceExact.length}/${unratified.length} != 128/0`);
    if (scenario.geometryOwnership.ratifiedRows !== sourceExact.length
        || scenario.geometryOwnership.unratifiedRows !== unratified.length
        || JSON.stringify(scenario.geometryOwnership.unratifiedFamilies) !== JSON.stringify([]))
      findings.push(`${id} serialized geometry ownership drift`);
    if (scenario.geometry.htmlSnapFits[0]?.rule !== "css-edge-round"
        || scenario.geometry.svgSnapFits[0]?.rule !== "css-edge-round")
      findings.push(`${id} no longer selects Blink CSS-edge snapping in both arms`);

    const invalidMetrics = sourceExact.filter((row) => !Number.isFinite(row.outerError)
      || !Number.isFinite(row.innerError) || !Number.isFinite(row.centerError)
      || !Number.isFinite(row.profileRmse));
    if (invalidMetrics.length !== 0)
      findings.push(`${id} has non-finite ratified metrics: ${invalidMetrics.map(({ id: rowId }) => rowId).join(", ")}`);
    const worstEdge = Math.max(...sourceExact.flatMap((row) => [row.outerError, row.innerError]));
    const worstRmse = Math.max(...sourceExact.map((row) => row.profileRmse));
    const edgeCeiling = envelope?.edgeCeilingCssPx ?? 0;
    const rmseCeiling = envelope?.profileRmseCeiling ?? 0;
    if (!Number.isFinite(worstEdge) || worstEdge > edgeCeiling)
      findings.push(`${id} ratified edge ${worstEdge} > ${edgeCeiling}`);
    if (!Number.isFinite(worstRmse) || worstRmse > rmseCeiling)
      findings.push(`${id} ratified profile ${worstRmse} > ${rmseCeiling}`);
    if (scenario.ratifiedPaintResiduals.failed.length !== 0)
      findings.push(`${id} producer reports ratified failures: ${scenario.ratifiedPaintResiduals.failed.join(", ")}`);
    if (Math.abs(scenario.ratifiedPaintResiduals.worstEdge - worstEdge) > 1e-12
        || Math.abs(scenario.ratifiedPaintResiduals.worstRmse - worstRmse) > 1e-12)
      findings.push(`${id} ratified summary does not match row evidence`);
    if (artifactDir != null) verifyArtifactHashes(scenario, artifactDir, findings);
    scenarioResults.push({
      id,
      ratifiedRows: sourceExact.length,
      unratifiedRows: unratified.length,
      worstEdge,
      edgeCeiling,
      worstRmse,
      rmseCeiling,
      pass: findings.length === scenarioFindingsBefore,
    });
  }
  for (const id of reportById.keys())
    if (!requiredScenarioIds.includes(id)) findings.push(`unexpected scenario ${id}`);

  return {
    schemaVersion: 1,
    platform: report.meta.platform,
    verdict: findings.length === 0 ? "ratified-source-exact" : "drift",
    artifactSetSha256: artifactSetFingerprint(report),
    ratifiedRows,
    unratifiedRows,
    unratifiedFamilies: [],
    findings,
    scenarios: scenarioResults,
  };
}

function option(args: string[], name: string, fallback = ""): string {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] != null ? args[index + 1] : fallback;
}

function main(): number {
  const args = process.argv.slice(2);
  const reportPath = option(args, "--report");
  const baselinePath = option(args, "--baseline", "tests/baselines/border-phase-envelopes.json");
  const runEnvPath = option(args, "--run-env");
  const artifactDir = option(args, "--artifact-dir");
  const jsonPath = option(args, "--json");
  if (!reportPath) throw new Error("--report is required");
  if (!runEnvPath) throw new Error("--run-env is required");
  if (!artifactDir) throw new Error("--artifact-dir is required");
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as BorderPhaseReport;
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as BorderPhaseEnvelope;
  const runEnvironment = JSON.parse(readFileSync(runEnvPath, "utf8")) as RunEnvironment;
  const result = adjudicateBorderPhaseReport(report, baseline, runEnvironment, artifactDir);
  const output = `${JSON.stringify(result, null, 2)}\n`;
  if (jsonPath) writeFileSync(jsonPath, output);
  process.stdout.write(output);
  return result.verdict === "ratified-source-exact" ? 0 : 1;
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = main(); }
  catch (error: unknown) { console.error(error); process.exitCode = 2; }
}
