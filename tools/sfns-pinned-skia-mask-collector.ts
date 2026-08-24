#!/usr/bin/env node
/** Run isolated native observations and assemble proposal-side SFNS evidence. */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import {
  SFNS_CONTROL_IDS,
  SFNS_CONTROL_REQUESTS,
  SFNS_GLYPH_IDS,
  SFNS_PINNED_SCENARIOS,
  SFNS_SCENARIO_CONTRACT,
  sfnsChangedEvidenceGroups,
  sfnsObservationLogicalDigest,
  sfnsPinnedArtifactDigest,
  validateSfnsPinnedSkiaProposal,
  type SfnsCollectorRequest,
  type SfnsControlId,
  type SfnsPinnedBuildMetadata,
  type SfnsPinnedObservation,
  type SfnsPinnedScenarioId,
  type SfnsPinnedSkiaProposalArtifact,
} from "./sfns-pinned-skia-mask-schema.js";

const argv = process.argv.slice(2);
function value(flag: string, fallback?: string): string {
  const index = argv.indexOf(flag);
  const result = index < 0 ? fallback : argv[index + 1];
  if (result == null || result.startsWith("--")) throw new Error(`missing ${flag}`);
  return result;
}

const binaryPath = resolve(value(
  "--binary", "tests/output/sfns-pinned-skia-collector/sfns_post_conversion_collector",
));
const buildMetadataPath = resolve(value(
  "--build-metadata", "tests/output/sfns-pinned-skia-collector/build-metadata.json",
));
const sourceArtifactPath = resolve(value(
  "--source-artifact", "tests/output/sfns-mask-baseline-dm2452/report.json",
));
const outputPath = resolve(value(
  "--out", "tests/output/sfns-pinned-skia-collector/proposal.json",
));
const observationDirectory = resolve(value(
  "--observation-directory", "tests/output/sfns-pinned-skia-collector/observations",
));

const fileSha = (path: string): string => createHash("sha256")
  .update(readFileSync(path)).digest("hex");

const build = JSON.parse(readFileSync(buildMetadataPath, "utf8")) as SfnsPinnedBuildMetadata;
if (fileSha(binaryPath) !== build.binary.sha256) {
  throw new Error("collector binary does not match build metadata");
}
const retainedBuild = structuredClone(build);
retainedBuild.binary.path = relative(process.cwd(), binaryPath);
const sourceArtifact = JSON.parse(readFileSync(sourceArtifactPath, "utf8")) as {
  authority?: unknown;
  environment?: Record<string, unknown>;
  rows?: Array<Record<string, unknown>>;
};
if (sourceArtifact.authority !== "diagnostic-only"
    || sourceArtifact.environment?.chromiumRevision
      !== "7d859f271cbda744098ac69f44978d4edfa62be3"
    || sourceArtifact.environment?.skiaRevision
      !== "62efacd37737505732dbe3d8daa62abd679626a1"
    || sourceArtifact.environment?.fontPath !== "/System/Library/Fonts/SFNS.ttf"
    || sourceArtifact.environment?.fontSha256
      !== "2bfd40dc72e6759e248f82a52a40d551338979fffc9b5c070e685b4b7ad19e66") {
  throw new Error("source outline artifact identity does not match the pinned corpus");
}
const sourceRows = new Map((sourceArtifact.rows ?? []).map((row) => [row.id, row]));
if (sourceArtifact.rows?.length !== SFNS_PINNED_SCENARIOS.length
    || sourceRows.size !== SFNS_PINNED_SCENARIOS.length) {
  throw new Error("source outline artifact must contain each scenario exactly once");
}
for (const id of SFNS_PINNED_SCENARIOS) {
  const row = sourceRows.get(id);
  const contract = SFNS_SCENARIO_CONTRACT[id];
  const expectedAxes = { wdth: 100, opsz: contract.opsz, GRAD: 400, wght: 700 };
  if (row == null
      || JSON.stringify(row.nativeGlyphIds) !== JSON.stringify(SFNS_GLYPH_IDS)
      || JSON.stringify(row.quarterPixelOrigins) !== JSON.stringify(contract.origins)
      || row.baseline == null
      || (row.baseline as Record<string, unknown>).emittedBaseline !== contract.baseline
      || JSON.stringify(row.requestedAxes) !== JSON.stringify(expectedAxes)) {
    throw new Error(`source outline artifact corpus mismatch for ${id}`);
  }
}
const sourceArtifactSha256 = fileSha(sourceArtifactPath);
mkdirSync(dirname(outputPath), { recursive: true });
mkdirSync(observationDirectory, { recursive: true });

function baseRequest(id: SfnsPinnedScenarioId): SfnsCollectorRequest {
  const contract = SFNS_SCENARIO_CONTRACT[id];
  return {
    fontSize: contract.fontSize,
    deviceScale: contract.deviceScale,
    opsz: contract.opsz,
    baseline: contract.baseline,
    phaseShiftX: 0,
    edging: "subpixel",
    hinting: "normal",
    pixelGeometry: "rgb-h",
  };
}

function nativeObservation(
  scenarioId: SfnsPinnedScenarioId,
  observationId: string,
  lifecycle: "cold" | "warm",
  ordinal: number,
  request: SfnsCollectorRequest,
): SfnsPinnedObservation {
  const contract = SFNS_SCENARIO_CONTRACT[scenarioId];
  const args = [
    "--scenario", scenarioId,
    "--observation-id", observationId,
    "--lifecycle", lifecycle,
    "--output-directory", observationDirectory,
    "--font-size", String(request.fontSize),
    "--device-scale", String(request.deviceScale),
    "--opsz", String(request.opsz),
    "--baseline", String(request.baseline),
    "--ordinal", String(ordinal),
    "--warmups", lifecycle === "warm" ? "1" : "0",
    "--phase-shift-x", String(request.phaseShiftX),
    "--origins", contract.origins.join(","),
    "--glyph-ids", SFNS_GLYPH_IDS.join(","),
    "--pixel-geometry", request.pixelGeometry,
    "--edging", request.edging,
    "--hinting", request.hinting,
  ];
  // Deliberately one native process per observation. This does not launch a browser.
  const result = spawnSync(binaryPath, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error([
      `native collector failed for ${observationId} (${result.status ?? result.signal})`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join("\n"));
  }
  try {
    return JSON.parse(result.stdout) as SfnsPinnedObservation;
  } catch (error) {
    throw new Error(`native collector emitted invalid JSON for ${observationId}: ${String(error)}`);
  }
}

const scenarios = SFNS_PINNED_SCENARIOS.map((id) => {
  const request = baseRequest(id);
  const observations = [
    nativeObservation(id, `${id}-cold-1`, "cold", 1, request),
    nativeObservation(id, `${id}-cold-2`, "cold", 2, request),
    nativeObservation(id, `${id}-warm-1`, "warm", 1, request),
    nativeObservation(id, `${id}-warm-2`, "warm", 2, request),
  ] as const;
  return {
    id,
    observationLogicalDigest: sfnsObservationLogicalDigest(observations[0]),
    observations: [...observations] as [
      SfnsPinnedObservation, SfnsPinnedObservation,
      SfnsPinnedObservation, SfnsPinnedObservation,
    ],
  };
});

const baseline = scenarios.find((scenario) => scenario.id === "zoom-2")!.observations[0];
const controls = SFNS_CONTROL_IDS.map((id: SfnsControlId) => {
  const request = { ...baseRequest("zoom-2"), ...SFNS_CONTROL_REQUESTS[id] };
  const observation = nativeObservation(
    "zoom-2", `control-${id}-cold-1`, "cold", 1, request,
  );
  return {
    id,
    baselineScenarioId: "zoom-2" as const,
    observation,
    changedEvidenceGroups: sfnsChangedEvidenceGroups(baseline, observation),
  };
});

const withoutDigest: Omit<SfnsPinnedSkiaProposalArtifact, "artifactDigest"> = {
  schemaVersion: 1,
  authority: "proposal-private-pinned-skia",
  arm: "proposal",
  collectionContract: {
    browserLaunches: 0,
    processIsolation: "one-native-process-per-observation",
    equality: "exact-bytes-no-tolerance",
  },
  build: retainedBuild,
  corpus: {
    sourceArtifact: relative(process.cwd(), sourceArtifactPath),
    sourceArtifactSha256,
    glyphIds: [...SFNS_GLYPH_IDS],
  },
  scenarios,
  controls,
};
const artifact: SfnsPinnedSkiaProposalArtifact = {
  ...withoutDigest,
  artifactDigest: sfnsPinnedArtifactDigest(withoutDigest),
};
const errors = validateSfnsPinnedSkiaProposal(artifact);
if (errors.length > 0) {
  throw new Error(`proposal artifact failed validation:\n${errors.join("\n")}`);
}
writeFileSync(outputPath, JSON.stringify(artifact, null, 2) + "\n");
console.log(JSON.stringify({
  output: outputPath,
  artifactDigest: artifact.artifactDigest,
  observations: scenarios.length * 4 + controls.length,
  browserLaunches: 0,
}));
