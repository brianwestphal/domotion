#!/usr/bin/env node
/** Collect 26 isolated native observations from the source-owned manifest. */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import {
  SFNS_TERMINAL_MASK_CONTROL_IDS,
  SFNS_TERMINAL_MASK_MANIFEST,
  SFNS_TERMINAL_MASK_MANIFEST_ABI,
  SFNS_TERMINAL_MASK_SCENARIO_IDS,
  sfnsTerminalMaskCase,
  sfnsTerminalMaskManifestDigest,
  type SfnsTerminalMaskCaseId,
  type SfnsTerminalMaskManifestCase,
} from "./sfns-terminal-mask-manifest.js";
import {
  sfnsChangedEvidenceGroups,
  sfnsObservationLogicalDigest,
  sfnsOtsMetadataDigest,
  sfnsPinnedArtifactDigest,
  validateSfnsPinnedSkiaProposal,
  type SfnsOtsMetadata,
  type SfnsPinnedBuildMetadata,
  type SfnsPinnedObservation,
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
const otsMetadataPath = resolve(value(
  "--ots-metadata", "tests/output/sfns-pinned-ots-sanitizer/ots-build-metadata.json",
));
const outputPath = resolve(value(
  "--out", "tests/output/sfns-pinned-skia-collector/dm2586-proposal.json",
));
const observationDirectory = resolve(value(
  "--observation-directory", "tests/output/sfns-pinned-skia-collector/dm2586-observations",
));

const fileSha = (path: string): string => createHash("sha256")
  .update(readFileSync(path)).digest("hex");

const build = JSON.parse(readFileSync(buildMetadataPath, "utf8")) as SfnsPinnedBuildMetadata;
if (fileSha(binaryPath) !== build.binary.sha256) {
  throw new Error("collector binary does not match build metadata");
}
const retainedBuild = structuredClone(build);
retainedBuild.binary.path = relative(process.cwd(), binaryPath);

const ots = JSON.parse(readFileSync(otsMetadataPath, "utf8")) as SfnsOtsMetadata;
const decodedFontPath = resolve(ots.decodedFont.path);
const otsBinaryPath = resolve(ots.binary.path);
if (fileSha(otsBinaryPath) !== ots.binary.sha256) {
  throw new Error("independent OTS binary does not match OTS metadata");
}
if (fileSha(decodedFontPath) !== ots.decodedFont.sha256) {
  throw new Error("independent OTS-decoded font does not match OTS metadata");
}
if (fileSha(ots.sourceFont.path) !== ots.sourceFont.sha256) {
  throw new Error("source font does not match independent OTS metadata");
}

mkdirSync(dirname(outputPath), { recursive: true });
if (existsSync(observationDirectory) && readdirSync(observationDirectory).length > 0) {
  throw new Error(`stale proposal observation directory refused: ${observationDirectory}`);
}
mkdirSync(observationDirectory, { recursive: true });

function nativeObservation(
  manifestCase: SfnsTerminalMaskManifestCase,
  lifecycle: "cold" | "warm",
  ordinal: number,
): SfnsPinnedObservation {
  const { request } = manifestCase;
  const observationId = manifestCase.kind === "control"
    ? `proposal-${manifestCase.id}-cold-1`
    : `proposal-${manifestCase.id}-${lifecycle}-${ordinal}`;
  const args = [
    "--case-id", manifestCase.id,
    "--kind", manifestCase.kind,
    "--scenario", manifestCase.scenarioId,
    "--control-id", manifestCase.controlId || "-",
    "--observation-id", observationId,
    "--lifecycle", lifecycle,
    "--output-directory", observationDirectory,
    "--source-font", ots.sourceFont.path,
    "--decoded-font", decodedFontPath,
    "--font-size", String(request.fontSize),
    "--wdth", String(request.axes.wdth),
    "--opsz", String(request.axes.opsz),
    "--grad", String(request.axes.GRAD),
    "--wght", String(request.axes.wght),
    "--source-start", request.run.sourceStart.join(","),
    "--device-baseline", String(request.run.deviceBaseline),
    "--device-matrix", request.run.liveDeviceMatrix.join(","),
    "--surface-flags", String(request.surface.flags),
    "--text-contrast", String(request.surface.textContrast),
    "--text-gamma", String(request.surface.textGamma),
    "--scaler-context-flags", String(request.scalerContextFlags),
    "--ordinal", String(ordinal),
    "--warmups", lifecycle === "warm" ? "1" : "0",
    "--glyph-ids", SFNS_TERMINAL_MASK_MANIFEST.corpus.glyphIds.join(","),
    "--pixel-geometry", request.surface.pixelGeometry,
    "--edging", request.font.edging,
    "--hinting", request.font.hinting,
  ];
  // Exactly one native process per observation. This does not launch a browser.
  const result = spawnSync(binaryPath, args, {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
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

const scenarios = SFNS_TERMINAL_MASK_SCENARIO_IDS.map((id) => {
  const manifestCase = sfnsTerminalMaskCase(id);
  const observations = [
    nativeObservation(manifestCase, "cold", 1),
    nativeObservation(manifestCase, "cold", 2),
    nativeObservation(manifestCase, "warm", 1),
    nativeObservation(manifestCase, "warm", 2),
  ] as const;
  return {
    id,
    request: manifestCase.request,
    observationLogicalDigest: sfnsObservationLogicalDigest(observations[0]),
    observations: [...observations] as [
      SfnsPinnedObservation,
      SfnsPinnedObservation,
      SfnsPinnedObservation,
      SfnsPinnedObservation,
    ],
  };
});

const baseline = scenarios.find((entry) => entry.id === "zoom-2")!.observations[0];
const controls = SFNS_TERMINAL_MASK_CONTROL_IDS.map((id) => {
  const caseId = `control-${id}` as SfnsTerminalMaskCaseId;
  const manifestCase = sfnsTerminalMaskCase(caseId);
  const observation = nativeObservation(manifestCase, "cold", 1);
  return {
    id,
    caseId: manifestCase.id as `control-${typeof id}`,
    baselineScenarioId: "zoom-2" as const,
    request: manifestCase.request,
    observation,
    changedEvidenceGroups: sfnsChangedEvidenceGroups(baseline, observation),
  };
});

const withoutDigest: Omit<SfnsPinnedSkiaProposalArtifact, "artifactDigest"> = {
  schemaVersion: 2,
  authority: "proposal-private-pinned-skia",
  arm: "proposal",
  manifest: {
    abi: SFNS_TERMINAL_MASK_MANIFEST_ABI,
    digest: sfnsTerminalMaskManifestDigest(),
  },
  collectionContract: {
    browserLaunches: 0,
    processIsolation: "one-native-process-per-observation",
    inputDerivation: "source-owned-manifest-independent-arm-derivation",
    equality: "exact-bytes-no-tolerance",
  },
  build: retainedBuild,
  ots: {
    metadataPath: relative(process.cwd(), otsMetadataPath),
    metadataSha256: fileSha(otsMetadataPath),
    metadataLogicalDigest: sfnsOtsMetadataDigest(ots),
    metadata: ots,
  },
  corpus: {
    text: SFNS_TERMINAL_MASK_MANIFEST.corpus.text,
    glyphIds: [...SFNS_TERMINAL_MASK_MANIFEST.corpus.glyphIds],
    collectionIndex: SFNS_TERMINAL_MASK_MANIFEST.corpus.collectionIndex,
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
writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(JSON.stringify({
  output: outputPath,
  artifactDigest: artifact.artifactDigest,
  observations: 26,
  browserLaunches: 0,
}));
