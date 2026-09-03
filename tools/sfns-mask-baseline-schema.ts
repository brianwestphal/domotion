/**
 * Integrity/classification seam for the macOS SFNS mask/baseline oracle.
 *
 * This module deliberately classifies observations; it does not define a
 * renderer tolerance. The live collector is `sfns-mask-baseline-oracle.ts`.
 */
import { createHash } from "node:crypto";

export const SFNS_BASE_AXES = {
  wdth: 100,
  opsz: 17,
  GRAD: 400,
  wght: 700,
} as const;

export const SFNS_MUTATION_AXES = { ...SFNS_BASE_AXES, opsz: 26 } as const;

export const SFNS_REQUIRED_SCENARIOS = [
  "zoom-2",
  "transform-scale-2",
  "zoom-2-transform-half",
  "optical-sizing-none",
  "opsz-26-mutation",
] as const;

export type SfnsScenarioId = typeof SFNS_REQUIRED_SCENARIOS[number];
export type SfnsAxes = Record<keyof typeof SFNS_BASE_AXES, number>;

export interface CoverageDiff {
  changedPixels: number;
  meanAbsoluteCoverage: number;
  maxAbsoluteCoverage: number;
  inkPixelsA: number;
  inkPixelsB: number;
  centroidYA: number | null;
  centroidYB: number | null;
  fixedYOffset: 0;
  bestIntegerYOffset: number;
  bestMeanAbsoluteCoverage: number;
}

export interface SfnsStageComparisons {
  chromiumVsNativeMask: CoverageDiff;
  chromiumVsCoreTextPath: CoverageDiff;
  chromiumVsDomotionPath: CoverageDiff;
  nativeMaskVsCoreTextPath: CoverageDiff;
  coreTextPathVsDomotionPath: CoverageDiff;
}

export interface SfnsBaselineEvidence {
  rangeTop: number;
  capturedTextTop: number;
  capturedAscent: number;
  capturedDescent: number;
  capturedBaseline: number;
  capturedBaselineQuarterPixel: number;
  emittedBaseline: number;
  browserCanvasAscent: number;
  browserCanvasDescent: number;
  nativeAscent: number;
  nativeDescent: number;
  nativeLeading: number;
  nativeBoundingBox: { x: number; y: number; width: number; height: number };
}

export interface SfnsLifecycleEvidence {
  chromiumColdSha256: [string, string];
  chromiumWarmSha256: [string, string];
  nativeColdMaskSha256: [string, string];
  nativeColdPathSha256: [string, string];
  nativeWarmMaskSha256: [string, string];
  nativeWarmPathSha256: [string, string];
  domotionColdSha256: [string, string];
  domotionWarmSha256: [string, string];
}

export interface SfnsOracleRow {
  id: SfnsScenarioId;
  mutation: boolean;
  requestedAxes: SfnsAxes;
  chromiumAxes: Partial<SfnsAxes>;
  nativeAxes: Partial<SfnsAxes>;
  domotionAxes: Partial<SfnsAxes>;
  nativeGlyphIds: number[];
  nativeMappedGlyphIds: number[];
  domotionGlyphIds: number[];
  rawOrigins: number[];
  quarterPixelOrigins: number[];
  nativeOrigins: number[];
  nativeBaselines: number[];
  domotionOrigins: number[];
  domotionEmittedOriginsRaw: number[];
  sizes: { logical: number; computed: number; paint: number };
  sourceIdentity: {
    chromiumPostscriptName: string;
    chromiumCustomFont: boolean;
    chromiumSourceSha256: string;
    nativePostscriptName: string;
    domotionPostscriptName: string;
    domotionSourcePath: string;
    domotionSourceSha256: string;
  };
  pathCommandCounts: { native: number[]; domotion: Array<number | null> };
  designCommandDigests: { native: string; domotion: string };
  /** Production ownership recorded at the emitter boundary for every gid. */
  outlineDispositions: string[];
  pathGeometry: {
    topologyMatches: boolean;
    /** Both independent command streams are compared on the helper's exact
     * serialized design-space lattice, never through a paint-pixel tolerance. */
    designUnitQuantum: 0.001;
    maxDesignUnitDelta: number;
    maxPaintPixelDelta: number;
    meanPaintPixelDelta: number;
    exactScale: number;
    domotionSerializedScale: number;
  };
  baseline: SfnsBaselineEvidence;
  lifecycle: SfnsLifecycleEvidence;
  comparisons: SfnsStageComparisons;
  stageDigests: {
    chromium: string;
    nativeMask: string;
    coreTextPath: string;
    domotionPath: string;
  };
  artifactPaths: {
    chromiumPng: string;
    nativeMaskPng: string;
    coreTextPathSvg: string;
    coreTextPathPng: string;
    domotionPathSvg: string;
    domotionPathPng: string;
  };
}

export type SfnsStageClassification =
  | "verdict-withheld"
  | "coretext-path-vs-domotion-path-divergence"
  | "native-mask-vs-coretext-path-rasterization"
  | "no-stage-divergence";

export interface SfnsRowClassification {
  classification: SfnsStageClassification;
  /** Lowest Chromium comparison after fitting only an integer y baseline. */
  closestRepresentation: "native-mask" | "coretext-path" | "domotion-path" | "exact-tie";
  integrityErrors: string[];
  /** Baseline is intentionally orthogonal to mask coverage. */
  baselineResidual: {
    nativeMaskBestIntegerYOffset: number;
    coreTextPathBestIntegerYOffset: number;
    domotionPathBestIntegerYOffset: number;
  };
}

export interface SfnsOracleArtifact {
  schemaVersion: 2;
  authority: "diagnostic-only";
  arm: "proposal" | "validation";
  observationId: string;
  logicalDigest: string;
  environment: {
    platform: "darwin";
    chromiumRevision: "7d859f271cbda744098ac69f44978d4edfa62be3";
    skiaRevision: "62efacd37737505732dbe3d8daa62abd679626a1";
    fontPath: "/System/Library/Fonts/SFNS.ttf";
    fontSha256: string;
    deviceScaleFactor: 1;
    chromiumVersion: string;
    osVersion: string;
    arch: string;
    helper: {
      available: true;
      path: string;
      sha256: string;
    };
  };
  rows: SfnsOracleRow[];
  classifications: Array<{ id: SfnsScenarioId } & SfnsRowClassification>;
  mutationControlMoved: boolean;
}

const axisKeys = Object.keys(SFNS_BASE_AXES) as Array<keyof SfnsAxes>;

export function quantizeQuarter(value: number): number {
  return Math.round(value * 4) / 4;
}

function sameNumbers(a: number[], b: number[], epsilon = 1e-9): boolean {
  return a.length === b.length && a.every((value, index) => Math.abs(value - b[index]) <= epsilon);
}

function axesMatch(actual: Partial<SfnsAxes>, expected: SfnsAxes): boolean {
  return Object.keys(actual).length === axisKeys.length
    && axisKeys.every((tag) => actual[tag] != null && Math.abs(actual[tag]! - expected[tag]) <= 1 / 65536);
}

function lifecycleStable(value: SfnsLifecycleEvidence): boolean {
  return value.chromiumColdSha256[0] === value.chromiumColdSha256[1]
    && value.chromiumWarmSha256[0] === value.chromiumWarmSha256[1]
    && value.chromiumColdSha256[0] === value.chromiumWarmSha256[0]
    && value.nativeColdMaskSha256[0] === value.nativeColdMaskSha256[1]
    && value.nativeColdPathSha256[0] === value.nativeColdPathSha256[1]
    && value.nativeWarmMaskSha256[0] === value.nativeWarmMaskSha256[1]
    && value.nativeWarmPathSha256[0] === value.nativeWarmPathSha256[1]
    && value.nativeColdMaskSha256[0] === value.nativeWarmMaskSha256[0]
    && value.nativeColdPathSha256[0] === value.nativeWarmPathSha256[0]
    && value.domotionColdSha256[0] === value.domotionColdSha256[1]
    && value.domotionWarmSha256[0] === value.domotionWarmSha256[1]
    && value.domotionColdSha256[0] === value.domotionWarmSha256[0];
}

function baselineFinite(value: SfnsBaselineEvidence): boolean {
  const { nativeBoundingBox, ...scalarMetrics } = value;
  return Object.values(scalarMetrics).every(Number.isFinite)
    && Object.values(nativeBoundingBox).every(Number.isFinite);
}

export function classifySfnsOracleRow(row: SfnsOracleRow): SfnsRowClassification {
  const integrityErrors: string[] = [];
  if (!axesMatch(row.chromiumAxes, row.requestedAxes)) integrityErrors.push("chromium-css-axis-state");
  if (!axesMatch(row.nativeAxes, row.requestedAxes)) integrityErrors.push("native-axis-state");
  if (!axesMatch(row.domotionAxes, row.requestedAxes)) integrityErrors.push("domotion-axis-state");
  if (!sameNumbers(row.nativeGlyphIds, row.domotionGlyphIds)) integrityErrors.push("glyph-identity");
  if (!sameNumbers(row.nativeMappedGlyphIds, row.nativeGlyphIds)) integrityErrors.push("native-cmap-glyph-identity");
  if (!sameNumbers(row.quarterPixelOrigins, row.rawOrigins.map(quantizeQuarter))) integrityErrors.push("quarter-origin-derivation");
  if (!sameNumbers(row.nativeOrigins, row.quarterPixelOrigins)) integrityErrors.push("native-origin-routing");
  if (row.nativeBaselines.length !== row.nativeGlyphIds.length
      || !sameNumbers(row.nativeBaselines, row.nativeBaselines.map(() => row.baseline.emittedBaseline))) {
    integrityErrors.push("native-baseline-routing");
  }
  if (row.baseline.capturedBaselineQuarterPixel !== quantizeQuarter(row.baseline.capturedBaseline)
      || row.baseline.emittedBaseline !== quantizeQuarter(row.baseline.emittedBaseline)) {
    integrityErrors.push("quarter-baseline-derivation");
  }
  if (!sameNumbers(row.domotionOrigins, row.quarterPixelOrigins)) integrityErrors.push("domotion-origin-routing");
  if (!lifecycleStable(row.lifecycle)) integrityErrors.push("cold-warm-instability");
  if (!baselineFinite(row.baseline)) integrityErrors.push("baseline-metrics");

  const baselineResidual = {
    nativeMaskBestIntegerYOffset: row.comparisons.chromiumVsNativeMask.bestIntegerYOffset,
    coreTextPathBestIntegerYOffset: row.comparisons.chromiumVsCoreTextPath.bestIntegerYOffset,
    domotionPathBestIntegerYOffset: row.comparisons.chromiumVsDomotionPath.bestIntegerYOffset,
  };
  // Fit only the integer baseline component before comparing representations.
  // Fixed-position coverage remains in the artifact and is never overwritten.
  const representationScores = [
    ["native-mask", row.comparisons.chromiumVsNativeMask.bestMeanAbsoluteCoverage],
    ["coretext-path", row.comparisons.chromiumVsCoreTextPath.bestMeanAbsoluteCoverage],
    ["domotion-path", row.comparisons.chromiumVsDomotionPath.bestMeanAbsoluteCoverage],
  ] as const;
  const allExact = representationScores.every(([, score]) => score === 0);
  const closestRepresentation = allExact ? "exact-tie" as const
    : [...representationScores].sort((left, right) => left[1] - right[1])[0][0];
  if (integrityErrors.length > 0) {
    return { classification: "verdict-withheld", closestRepresentation, integrityErrors, baselineResidual };
  }
  if (!row.pathGeometry.topologyMatches || row.pathGeometry.maxPaintPixelDelta > 0
      || row.comparisons.coreTextPathVsDomotionPath.changedPixels > 0) {
    return { classification: "coretext-path-vs-domotion-path-divergence", closestRepresentation, integrityErrors, baselineResidual };
  }
  if (row.comparisons.nativeMaskVsCoreTextPath.changedPixels > 0) {
    return { classification: "native-mask-vs-coretext-path-rasterization", closestRepresentation, integrityErrors, baselineResidual };
  }
  return { classification: "no-stage-divergence", closestRepresentation, integrityErrors, baselineResidual };
}

export function validateSfnsOracleArtifact(artifact: SfnsOracleArtifact): string[] {
  const errors: string[] = [];
  if (artifact.schemaVersion !== 2) errors.push("schema-version");
  if (artifact.authority !== "diagnostic-only") errors.push("authority");
  const byId = new Map(artifact.rows.map((row) => [row.id, row]));
  for (const id of SFNS_REQUIRED_SCENARIOS) {
    if (!byId.has(id)) errors.push(`missing-scenario:${id}`);
  }
  for (const row of artifact.rows) {
    if (!row.sourceIdentity.chromiumCustomFont) errors.push(`${row.id}:chromium-not-exact-byte-font`);
    if (row.sourceIdentity.chromiumSourceSha256 !== artifact.environment.fontSha256) {
      errors.push(`${row.id}:chromium-font-bytes`);
    }
    if (row.sourceIdentity.domotionSourcePath !== artifact.environment.fontPath
        || row.sourceIdentity.domotionSourceSha256 !== artifact.environment.fontSha256) {
      errors.push(`${row.id}:domotion-font-bytes`);
    }
    const classification = classifySfnsOracleRow(row);
    if (classification.integrityErrors.length > 0) {
      errors.push(...classification.integrityErrors.map((error) => `${row.id}:${error}`));
    }
  }
  const base = byId.get("zoom-2");
  const mutation = byId.get("opsz-26-mutation");
  const mutationMoved = base != null && mutation != null
    && base.stageDigests.chromium !== mutation.stageDigests.chromium
    && base.stageDigests.nativeMask !== mutation.stageDigests.nativeMask
    && base.stageDigests.coreTextPath !== mutation.stageDigests.coreTextPath
    && base.stageDigests.domotionPath !== mutation.stageDigests.domotionPath;
  if (!mutationMoved || !artifact.mutationControlMoved) errors.push("opsz-mutation-did-not-move-all-stages");
  return errors;
}

/** Exact logical identity exported for independent proposal/validation arms.
 * Filesystem paths, observation nonce, raster bytes, and per-arm lifecycle
 * hashes are deliberately excluded. Lifecycle stability is validated inside
 * each arm; every source, axis, gid, quarter-origin, command-ownership, and
 * command-geometry fact remains in the cross-arm digest. */
export function sfnsOutlineLogicalDigest(artifact: SfnsOracleArtifact): string {
  const rows = [...artifact.rows]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((row) => ({
      id: row.id,
      mutation: row.mutation,
      requestedAxes: row.requestedAxes,
      chromiumAxes: row.chromiumAxes,
      nativeAxes: row.nativeAxes,
      domotionAxes: row.domotionAxes,
      nativeGlyphIds: row.nativeGlyphIds,
      nativeMappedGlyphIds: row.nativeMappedGlyphIds,
      domotionGlyphIds: row.domotionGlyphIds,
      quarterPixelOrigins: row.quarterPixelOrigins,
      nativeOrigins: row.nativeOrigins,
      nativeBaselines: row.nativeBaselines,
      sizes: row.sizes,
      sourceIdentity: row.sourceIdentity,
      pathCommandCounts: row.pathCommandCounts,
      designCommandDigests: row.designCommandDigests,
      outlineDispositions: row.outlineDispositions,
      pathGeometry: row.pathGeometry,
    }));
  const payload = {
    environment: {
      platform: artifact.environment.platform,
      chromiumRevision: artifact.environment.chromiumRevision,
      skiaRevision: artifact.environment.skiaRevision,
      fontPath: artifact.environment.fontPath,
      fontSha256: artifact.environment.fontSha256,
      deviceScaleFactor: artifact.environment.deviceScaleFactor,
      chromiumVersion: artifact.environment.chromiumVersion,
      arch: artifact.environment.arch,
    },
    rows,
    mutationControlMoved: artifact.mutationControlMoved,
  };
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value != null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]));
    }
    return value;
  };
  return createHash("sha256").update(JSON.stringify(canonicalize(payload))).digest("hex");
}

/** Gate only the exact outline-ownership seam closed by DM-2567. The sibling
 * mask/baseline classifier remains diagnostic because terminal raster coverage
 * is a separate representation question. */
export function validateSfnsExactOutlineArtifact(artifact: SfnsOracleArtifact): string[] {
  const errors: string[] = [];
  if (artifact.schemaVersion !== 2) errors.push("schema-version");
  if (artifact.arm !== "proposal" && artifact.arm !== "validation") errors.push("arm");
  if (artifact.observationId.trim() === "") errors.push("observation-id");
  if (!artifact.environment.helper.available) errors.push("helper-unavailable");
  if (artifact.environment.helper.path.trim() === "") errors.push("helper-path");
  if (!/^[0-9a-f]{64}$/.test(artifact.environment.helper.sha256)) errors.push("helper-sha256");

  const byId = new Map(artifact.rows.map((row) => [row.id, row]));
  for (const id of SFNS_REQUIRED_SCENARIOS) {
    const row = byId.get(id);
    if (row == null) {
      errors.push(`missing-scenario:${id}`);
      continue;
    }
    if (!row.sourceIdentity.chromiumCustomFont) errors.push(`${id}:chromium-not-exact-byte-font`);
    if (row.sourceIdentity.chromiumSourceSha256 !== artifact.environment.fontSha256) {
      errors.push(`${id}:chromium-font-bytes`);
    }
    if (row.sourceIdentity.domotionSourcePath !== artifact.environment.fontPath
        || row.sourceIdentity.domotionSourceSha256 !== artifact.environment.fontSha256) {
      errors.push(`${id}:domotion-font-bytes`);
    }
    if (!axesMatch(row.chromiumAxes, row.requestedAxes)) errors.push(`${id}:chromium-css-axis-state`);
    if (!axesMatch(row.nativeAxes, row.requestedAxes)) errors.push(`${id}:native-axis-state`);
    if (!axesMatch(row.domotionAxes, row.requestedAxes)) errors.push(`${id}:domotion-axis-state`);
    if (!sameNumbers(row.nativeGlyphIds, row.nativeMappedGlyphIds)
        || !sameNumbers(row.nativeGlyphIds, row.domotionGlyphIds)) errors.push(`${id}:glyph-identity`);
    if (!sameNumbers(row.quarterPixelOrigins, row.rawOrigins.map(quantizeQuarter))) {
      errors.push(`${id}:quarter-origin-derivation`);
    }
    if (!sameNumbers(row.nativeOrigins, row.quarterPixelOrigins)) errors.push(`${id}:native-origin-routing`);
    if (row.nativeBaselines.length !== row.nativeGlyphIds.length
        || !sameNumbers(row.nativeBaselines, row.nativeBaselines.map(() => row.baseline.emittedBaseline))) {
      errors.push(`${id}:native-baseline-routing`);
    }
    if (!lifecycleStable(row.lifecycle)) errors.push(`${id}:cold-warm-instability`);
    if (row.outlineDispositions.length !== row.domotionGlyphIds.length
        || row.outlineDispositions.some((disposition) => disposition !== "helper-outline")) {
      errors.push(`${id}:outline-ownership`);
    }
    if (!sameNumbers(row.pathCommandCounts.native, row.pathCommandCounts.domotion.map((count) => count ?? -1))) {
      errors.push(`${id}:command-counts`);
    }
    if (row.designCommandDigests.native !== row.designCommandDigests.domotion) {
      errors.push(`${id}:design-command-digest`);
    }
    if (!row.pathGeometry.topologyMatches) errors.push(`${id}:command-topology`);
    if (row.pathGeometry.designUnitQuantum !== 0.001) errors.push(`${id}:design-unit-quantum`);
    if (row.pathGeometry.maxDesignUnitDelta !== 0
        || row.pathGeometry.maxPaintPixelDelta !== 0
        || row.pathGeometry.meanPaintPixelDelta !== 0) {
      errors.push(`${id}:exact-design-geometry`);
    }
  }

  const base = byId.get("zoom-2");
  const mutation = byId.get("opsz-26-mutation");
  const mutationMoved = base != null && mutation != null
    && base.stageDigests.chromium !== mutation.stageDigests.chromium
    && base.stageDigests.nativeMask !== mutation.stageDigests.nativeMask
    && base.stageDigests.coreTextPath !== mutation.stageDigests.coreTextPath
    && base.stageDigests.domotionPath !== mutation.stageDigests.domotionPath;
  if (!mutationMoved || !artifact.mutationControlMoved) errors.push("opsz-mutation-did-not-move-all-stages");
  if (base != null && mutation != null
      && (base.designCommandDigests.native === mutation.designCommandDigests.native
        || base.designCommandDigests.domotion === mutation.designCommandDigests.domotion)) {
    errors.push("opsz-mutation-did-not-move-design-commands");
  }
  if (artifact.logicalDigest !== sfnsOutlineLogicalDigest(artifact)) errors.push("logical-digest");
  return errors;
}

/** Require two independently launched observations to reach the same exact
 * logical result. This is an equality gate, not a threshold or pixel fit. */
export function validateSfnsProposalValidation(
  proposal: SfnsOracleArtifact,
  validation: SfnsOracleArtifact,
): string[] {
  const errors = [
    ...validateSfnsExactOutlineArtifact(proposal).map((error) => `proposal:${error}`),
    ...validateSfnsExactOutlineArtifact(validation).map((error) => `validation:${error}`),
  ];
  if (proposal.arm !== "proposal") errors.push("proposal:wrong-arm");
  if (validation.arm !== "validation") errors.push("validation:wrong-arm");
  if (proposal.observationId === validation.observationId) errors.push("observations-not-independent");
  if (proposal.logicalDigest !== validation.logicalDigest) errors.push("proposal-validation-logical-digest");
  return errors;
}
