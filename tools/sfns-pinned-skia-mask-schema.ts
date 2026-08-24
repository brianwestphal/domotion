/**
 * Fail-closed schema for the proposal-side, pinned-Skia SFNS mask collector.
 *
 * This is evidence infrastructure only. It records exact bytes and exact
 * equality; it neither changes production rendering nor defines a tolerance.
 */
import { createHash } from "node:crypto";

export const SFNS_PINNED_CHROMIUM_REVISION = "7d859f271cbda744098ac69f44978d4edfa62be3";
export const SFNS_PINNED_SKIA_REVISION = "62efacd37737505732dbe3d8daa62abd679626a1";
export const SFNS_FONT_PATH = "/System/Library/Fonts/SFNS.ttf";
export const SFNS_FONT_SHA256 = "2bfd40dc72e6759e248f82a52a40d551338979fffc9b5c070e685b4b7ad19e66";
export const SFNS_COLLECTOR_ABI = "domotion-sfns-pinned-skia-mask-v1";
export const SFNS_GLYPH_IDS = [969, 815, 815, 795, 1310, 1377] as const;
export const SFNS_REQUIRED_AXES = { wdth: 100, opsz: 17, GRAD: 400, wght: 700 } as const;

export const SFNS_PINNED_SCENARIOS = [
  "zoom-2",
  "transform-scale-2",
  "zoom-2-transform-half",
  "optical-sizing-none",
  "opsz-26-mutation",
] as const;
export type SfnsPinnedScenarioId = typeof SFNS_PINNED_SCENARIOS[number];

export const SFNS_CONTROL_IDS = [
  "subpixel-phase",
  "anti-aliasing",
  "hinting",
  "device-matrix",
  "optical-size",
  "surface-mask-format",
] as const;
export type SfnsControlId = typeof SFNS_CONTROL_IDS[number];

export interface SfnsCollectorRequest {
  fontSize: number;
  deviceScale: number;
  opsz: number;
  baseline: number;
  phaseShiftX: number;
  edging: "alias" | "aa" | "subpixel";
  hinting: "none" | "slight" | "normal" | "full";
  pixelGeometry: "unknown" | "rgb-h" | "bgr-h" | "rgb-v" | "bgr-v";
}

export interface SfnsRecEvidence {
  byteLength: number;
  bytesBase64: string;
  sha256: string;
  dump: string;
  textSize: number;
  maskFormat: string;
  flags: number;
  hinting: string;
  luminanceColor: number;
  singleMatrix: number[];
}

export interface SfnsMaskGlyph {
  index: number;
  gid: number;
  advance: number[];
  offset: number[];
  baseline: number;
  deviceOrigin: number;
  phaseShiftX: number;
  packedId: number;
  phase: { x: number; y: number };
  rounding: { halfAxisSampleFreq: number[]; ignorePositionFieldMask: number[] };
  metrics: {
    left: number; top: number; width: number; height: number;
    maskFormat: string; rowBytes: number; imageSize: number;
  };
  mask: { encoding: "base64"; bytes: string; sha256: string; file: string };
}

export interface SfnsPinnedObservation {
  schemaVersion: 1;
  collectorAbi: string;
  observationId: string;
  scenarioId: string;
  lifecycle: "cold" | "warm";
  ordinal: number;
  warmupCount: number;
  source: {
    chromiumRevision: string; skiaRevision: string; fontPath: string;
    fontByteLength: number; fontSha256: string;
  };
  buildRuntime: { clangVersion: string; architecture: string };
  request: SfnsCollectorRequest;
  typeface: {
    uniqueId: number; family: string; postscriptName: string;
    style: { weight: number; width: number; slant: number };
    axes: Array<{
      tag: string; min: number; default: number; max: number; hidden: boolean;
      requested: number; actual: number;
    }>;
  };
  font: {
    size: number; scaleX: number; skewX: number; subpixel: boolean;
    linearMetrics: boolean; embeddedBitmaps: boolean; edging: string; hinting: string;
  };
  paint: { color: number; style: number };
  surfaceProps: {
    flags: number; pixelGeometry: string; textContrast: number; textGamma: number;
  };
  scalerContextFlags: string;
  rawRec: SfnsRecEvidence;
  filteredRec: SfnsRecEvidence;
  matrices: {
    device: number[]; total: number[]; scale: number[]; remaining: number[];
    remainingWithoutRotation: number[]; remainingRotation: number[]; invertible: boolean;
  };
  smoothBehavior: "none" | "some" | "subpixel";
  gamma: {
    inputContrast: number; inputDeviceGamma: number; tableApplicable: boolean;
    tableWidth: number; tableHeight: number; tableByteLength: number; tableSha256: string;
    preblendApplicable: boolean; preblendR256Sha256: string;
    preblendG256Sha256: string; preblendB256Sha256: string;
  };
  fontMetrics: {
    top: number; ascent: number; descent: number; bottom: number; leading: number;
    avgCharWidth: number; maxCharWidth: number; xMin: number; xMax: number;
    xHeight: number; capHeight: number;
  };
  glyphs: SfnsMaskGlyph[];
}

export interface SfnsScenarioEvidence {
  id: SfnsPinnedScenarioId;
  observationLogicalDigest: string;
  observations: [
    SfnsPinnedObservation, SfnsPinnedObservation,
    SfnsPinnedObservation, SfnsPinnedObservation,
  ];
}

export interface SfnsControlEvidence {
  id: SfnsControlId;
  baselineScenarioId: "zoom-2";
  observation: SfnsPinnedObservation;
  changedEvidenceGroups: string[];
}

export interface SfnsPinnedBuildMetadata {
  schemaVersion: 1;
  authority: "proposal-private-pinned-skia";
  chromiumRevision: string;
  skiaRevision: string;
  platform: string;
  architecture: string;
  gnArgs: string;
  source: { builderSha256: string; cppSha256: string; buildGnSha256: string };
  toolchain: {
    gnSha256: string; ninjaSha256: string; clangPath: string;
    clangSha256: string; clangVersion: string;
  };
  binary: { path: string; sha256: string };
}

export interface SfnsPinnedSkiaProposalArtifact {
  schemaVersion: 1;
  authority: "proposal-private-pinned-skia";
  arm: "proposal";
  collectionContract: {
    browserLaunches: 0;
    processIsolation: "one-native-process-per-observation";
    equality: "exact-bytes-no-tolerance";
  };
  build: SfnsPinnedBuildMetadata;
  corpus: {
    sourceArtifact: string;
    sourceArtifactSha256: string;
    glyphIds: number[];
  };
  scenarios: SfnsScenarioEvidence[];
  controls: SfnsControlEvidence[];
  artifactDigest: string;
}

const EXPECTED_SCENARIOS: Record<SfnsPinnedScenarioId, {
  fontSize: number; deviceScale: number; opsz: number; baseline: number; origins: number[];
}> = {
  "zoom-2": {
    fontSize: 26, deviceScale: 1, opsz: 17, baseline: 43,
    origins: [37.25, 51.75, 67.75, 84, 108, 124.75],
  },
  "transform-scale-2": {
    fontSize: 13, deviceScale: 2, opsz: 17, baseline: 45.25,
    origins: [37.25, 51.75, 67.75, 84, 108, 124.75],
  },
  "zoom-2-transform-half": {
    fontSize: 26, deviceScale: 0.5, opsz: 17, baseline: 30.75,
    origins: [37.25, 44.5, 52.5, 60.5, 72.75, 81],
  },
  "optical-sizing-none": {
    fontSize: 26, deviceScale: 1, opsz: 17, baseline: 43,
    origins: [37.25, 51.75, 67.75, 84, 108, 124.75],
  },
  "opsz-26-mutation": {
    fontSize: 26, deviceScale: 1, opsz: 26, baseline: 43,
    origins: [37.25, 50.25, 65.25, 80.25, 103, 118.75],
  },
};

const CONTROL_REQUESTS: Record<SfnsControlId, Partial<SfnsCollectorRequest>> = {
  "subpixel-phase": { phaseShiftX: 1 },
  "anti-aliasing": { edging: "aa" },
  hinting: { hinting: "none" },
  "device-matrix": { deviceScale: 1.25 },
  "optical-size": { opsz: 26 },
  "surface-mask-format": { pixelGeometry: "unknown" },
};

const REQUIRED_CONTROL_GROUPS: Record<SfnsControlId, string[]> = {
  "subpixel-phase": ["phase", "mask"],
  "anti-aliasing": ["request", "rec"],
  hinting: ["request", "rec"],
  "device-matrix": ["matrix", "mask"],
  "optical-size": ["axis", "mask"],
  "surface-mask-format": ["surface", "rec"],
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value != null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]));
  }
  return value;
}

function sha(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashJson(value: unknown): string {
  return sha(JSON.stringify(canonicalize(value)));
}

function sameNumbers(actual: number[], expected: readonly number[]): boolean {
  return actual.length === expected.length
    && actual.every((value, index) => Number.isFinite(value) && value === expected[index]);
}

function base64Bytes(value: string): Buffer | null {
  try {
    const bytes = Buffer.from(value, "base64");
    return bytes.toString("base64") === value ? bytes : null;
  } catch {
    return null;
  }
}

function shaValid(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function observationPayload(observation: SfnsPinnedObservation): unknown {
  return {
    schemaVersion: observation.schemaVersion,
    collectorAbi: observation.collectorAbi,
    scenarioId: observation.scenarioId,
    source: observation.source,
    buildRuntime: observation.buildRuntime,
    request: observation.request,
    typeface: { ...observation.typeface, uniqueId: undefined },
    font: observation.font,
    paint: observation.paint,
    surfaceProps: observation.surfaceProps,
    scalerContextFlags: observation.scalerContextFlags,
    rawRec: observation.rawRec,
    filteredRec: observation.filteredRec,
    matrices: observation.matrices,
    smoothBehavior: observation.smoothBehavior,
    gamma: observation.gamma,
    fontMetrics: observation.fontMetrics,
    glyphs: observation.glyphs.map((glyph) => ({
      ...glyph,
      mask: { ...glyph.mask, file: undefined },
    })),
  };
}

export function sfnsObservationLogicalDigest(observation: SfnsPinnedObservation): string {
  return hashJson(observationPayload(observation));
}

export function sfnsEvidenceGroups(observation: SfnsPinnedObservation): Record<string, string> {
  return {
    request: hashJson(observation.request),
    phase: hashJson(observation.glyphs.map((glyph) => ({
      packedId: glyph.packedId, phase: glyph.phase, phaseShiftX: glyph.phaseShiftX,
    }))),
    mask: hashJson(observation.glyphs.map((glyph) => ({
      metrics: glyph.metrics, sha256: glyph.mask.sha256,
    }))),
    rec: hashJson({ raw: observation.rawRec, filtered: observation.filteredRec }),
    matrix: hashJson(observation.matrices),
    axis: hashJson(observation.typeface.axes),
    surface: hashJson(observation.surfaceProps),
    gamma: hashJson(observation.gamma),
  };
}

export function sfnsChangedEvidenceGroups(
  baseline: SfnsPinnedObservation,
  candidate: SfnsPinnedObservation,
): string[] {
  const before = sfnsEvidenceGroups(baseline);
  const after = sfnsEvidenceGroups(candidate);
  return Object.keys(before).filter((key) => before[key] !== after[key]).sort();
}

export function sfnsPinnedArtifactDigest(
  artifact: Omit<SfnsPinnedSkiaProposalArtifact, "artifactDigest"> | SfnsPinnedSkiaProposalArtifact,
): string {
  const { artifactDigest: unused, ...payload } = artifact as SfnsPinnedSkiaProposalArtifact;
  void unused;
  return hashJson(payload);
}

function validateRec(rec: SfnsRecEvidence, label: string, errors: string[]): void {
  const bytes = base64Bytes(rec.bytesBase64);
  if (bytes == null) errors.push(`${label}:base64`);
  else {
    if (bytes.length !== rec.byteLength) errors.push(`${label}:byte-length`);
    if (sha(bytes) !== rec.sha256) errors.push(`${label}:sha256`);
  }
  if (!shaValid(rec.sha256)) errors.push(`${label}:sha256-shape`);
  if (rec.byteLength !== 56) errors.push(`${label}:pinned-rec-size`);
  if (!sameNumbers(rec.singleMatrix, rec.singleMatrix) || rec.singleMatrix.length !== 9) {
    errors.push(`${label}:single-matrix`);
  }
}

function validateObservation(
  observation: SfnsPinnedObservation,
  scenario: SfnsPinnedScenarioId,
  origins: readonly number[],
  errors: string[],
): void {
  const label = observation.observationId || `${scenario}:unnamed`;
  if (observation.schemaVersion !== 1) errors.push(`${label}:schema-version`);
  if (observation.collectorAbi !== SFNS_COLLECTOR_ABI) errors.push(`${label}:collector-abi`);
  if (observation.scenarioId !== scenario) errors.push(`${label}:scenario-id`);
  if (observation.source.chromiumRevision !== SFNS_PINNED_CHROMIUM_REVISION
      || observation.source.skiaRevision !== SFNS_PINNED_SKIA_REVISION) {
    errors.push(`${label}:source-revision`);
  }
  if (observation.source.fontPath !== SFNS_FONT_PATH
      || observation.source.fontSha256 !== SFNS_FONT_SHA256
      || observation.source.fontByteLength !== 7_909_644) errors.push(`${label}:font-bytes`);
  if (observation.buildRuntime.architecture.trim() === ""
      || observation.buildRuntime.clangVersion.trim() === "") errors.push(`${label}:build-runtime`);
  if (observation.typeface.uniqueId <= 0
      || observation.typeface.family !== ".SF NS"
      || !observation.typeface.postscriptName.startsWith(".SFNS-")
      || observation.typeface.style.weight !== 700
      || observation.typeface.style.width !== 5
      || observation.typeface.style.slant !== 0) errors.push(`${label}:typeface-identity`);
  if (observation.typeface.axes.length !== Object.keys(SFNS_REQUIRED_AXES).length) {
    errors.push(`${label}:axis-count`);
  }
  const axes = new Map(observation.typeface.axes.map((axis) => [axis.tag, axis]));
  for (const [tag, baseValue] of Object.entries(SFNS_REQUIRED_AXES)) {
    const expected = tag === "opsz" ? observation.request.opsz : baseValue;
    const axis = axes.get(tag);
    if (axis == null || axis.requested !== expected || axis.actual !== expected) {
      errors.push(`${label}:axis:${tag}`);
    }
    if (axis != null && (!Number.isFinite(axis.min) || !Number.isFinite(axis.default)
      || !Number.isFinite(axis.max) || axis.min > axis.actual || axis.actual > axis.max)) {
      errors.push(`${label}:axis-range:${tag}`);
    }
  }
  validateRec(observation.rawRec, `${label}:raw-rec`, errors);
  validateRec(observation.filteredRec, `${label}:filtered-rec`, errors);
  const effectiveScale = observation.request.fontSize * observation.request.deviceScale;
  if (observation.rawRec.textSize !== observation.request.fontSize
      || observation.filteredRec.textSize !== observation.request.fontSize) {
    errors.push(`${label}:rec-text-size`);
  }
  const rawMaskFormat = observation.request.edging === "subpixel"
      && observation.request.pixelGeometry !== "unknown" ? "LCD16" : "A8";
  const filteredMaskFormat = rawMaskFormat === "LCD16"
      && observation.smoothBehavior === "subpixel" ? "LCD16" : "A8";
  if (observation.rawRec.maskFormat !== rawMaskFormat
      || observation.filteredRec.maskFormat !== filteredMaskFormat) {
    errors.push(`${label}:rec-mask-format-route`);
  }
  if (observation.rawRec.hinting !== observation.request.hinting
      || observation.filteredRec.hinting !== "normal") errors.push(`${label}:rec-hinting-route`);
  if (observation.font.size !== observation.request.fontSize
      || observation.font.scaleX !== 1 || observation.font.skewX !== 0
      || !observation.font.subpixel || !observation.font.linearMetrics
      || observation.font.embeddedBitmaps
      || observation.font.edging !== observation.request.edging
      || observation.font.hinting !== observation.request.hinting) errors.push(`${label}:font-request`);
  if (observation.paint.color !== 4_278_190_080 || observation.paint.style !== 0) {
    errors.push(`${label}:paint`);
  }
  if (observation.surfaceProps.flags !== 0
      || observation.surfaceProps.pixelGeometry !== observation.request.pixelGeometry
      || observation.surfaceProps.textContrast !== 0.5
      || observation.surfaceProps.textGamma !== 0) errors.push(`${label}:surface-props`);
  if (observation.scalerContextFlags !== "fake-gamma-and-boost-contrast") {
    errors.push(`${label}:scaler-context-flags`);
  }
  if (!observation.matrices.invertible) errors.push(`${label}:matrix-not-invertible`);
  const matrixLengths: Record<string, number> = {
    device: 9, total: 9, scale: 2, remaining: 9,
    remainingWithoutRotation: 9, remainingRotation: 9,
  };
  for (const [key, length] of Object.entries(matrixLengths)) {
    const matrix = observation.matrices[key as keyof typeof observation.matrices];
    if (!Array.isArray(matrix) || matrix.length !== length
        || matrix.some((entry) => !Number.isFinite(entry))) errors.push(`${label}:matrix:${key}`);
  }
  const scaleMatrix = (scale: number): number[] => [scale, 0, 0, 0, scale, 0, 0, 0, 1];
  const identity = scaleMatrix(1);
  if (!sameNumbers(observation.matrices.device, scaleMatrix(observation.request.deviceScale))
      || !sameNumbers(observation.matrices.total, scaleMatrix(effectiveScale))
      || !sameNumbers(observation.matrices.scale, [effectiveScale, effectiveScale])
      || !sameNumbers(observation.matrices.remaining, identity)
      || !sameNumbers(observation.matrices.remainingWithoutRotation, identity)
      || !sameNumbers(observation.matrices.remainingRotation, identity)
      || !sameNumbers(observation.rawRec.singleMatrix, observation.matrices.total)
      || !sameNumbers(observation.filteredRec.singleMatrix, observation.matrices.total)) {
    errors.push(`${label}:matrix-factorization`);
  }
  if (!["none", "some", "subpixel"].includes(observation.smoothBehavior)) {
    errors.push(`${label}:smooth-behavior`);
  }
  if (observation.gamma.inputContrast !== 0.5 || observation.gamma.inputDeviceGamma !== 0
      || !observation.gamma.tableApplicable || observation.gamma.tableWidth !== 256
      || observation.gamma.tableHeight !== 8 || observation.gamma.tableByteLength !== 2_048
      || !observation.gamma.preblendApplicable
      || ![
        observation.gamma.tableSha256, observation.gamma.preblendR256Sha256,
        observation.gamma.preblendG256Sha256, observation.gamma.preblendB256Sha256,
      ].every(shaValid)) errors.push(`${label}:gamma-preblend`);
  if (!Object.values(observation.fontMetrics).every(Number.isFinite)) {
    errors.push(`${label}:font-metrics`);
  }
  if (observation.glyphs.length !== SFNS_GLYPH_IDS.length) errors.push(`${label}:glyph-count`);
  observation.glyphs.forEach((glyph, index) => {
    const glyphLabel = `${label}:glyph:${index}`;
    if (glyph.index !== index || glyph.gid !== SFNS_GLYPH_IDS[index]) errors.push(`${glyphLabel}:identity`);
    if (glyph.deviceOrigin !== origins[index] || glyph.baseline !== observation.request.baseline) {
      errors.push(`${glyphLabel}:position`);
    }
    if (glyph.phaseShiftX !== observation.request.phaseShiftX
        || glyph.phase.x !== (glyph.packedId & 3)
        || glyph.phase.y !== ((glyph.packedId >>> 18) & 3)) errors.push(`${glyphLabel}:packed-phase`);
    if (glyph.advance.length !== 2 || glyph.offset.length !== 2
        || ![...glyph.advance, ...glyph.offset].every(Number.isFinite)) {
      errors.push(`${glyphLabel}:advance-offset`);
    }
    if (![glyph.metrics.left, glyph.metrics.top, glyph.metrics.width, glyph.metrics.height,
      glyph.metrics.rowBytes, glyph.metrics.imageSize].every(Number.isFinite)
      || glyph.metrics.width < 0 || glyph.metrics.height < 0 || glyph.metrics.rowBytes < 0
      || glyph.metrics.imageSize !== glyph.metrics.rowBytes * glyph.metrics.height) {
      errors.push(`${glyphLabel}:metrics`);
    }
    const bytes = base64Bytes(glyph.mask.bytes);
    if (glyph.mask.encoding !== "base64" || bytes == null) errors.push(`${glyphLabel}:base64`);
    else {
      if (bytes.length !== glyph.metrics.imageSize) errors.push(`${glyphLabel}:image-size`);
      if (sha(bytes) !== glyph.mask.sha256) errors.push(`${glyphLabel}:sha256`);
    }
    if (!shaValid(glyph.mask.sha256)) errors.push(`${glyphLabel}:sha256-shape`);
    if (glyph.metrics.maskFormat !== observation.filteredRec.maskFormat) {
      errors.push(`${glyphLabel}:filtered-mask-format`);
    }
  });
}

function expectedControlRequest(id: SfnsControlId): SfnsCollectorRequest {
  return {
    fontSize: 26, deviceScale: 1, opsz: 17, baseline: 43, phaseShiftX: 0,
    edging: "subpixel", hinting: "normal", pixelGeometry: "rgb-h",
    ...CONTROL_REQUESTS[id],
  };
}

export function validateSfnsPinnedSkiaProposal(
  artifact: SfnsPinnedSkiaProposalArtifact,
): string[] {
  const errors: string[] = [];
  if (artifact.schemaVersion !== 1) errors.push("schema-version");
  if (artifact.authority !== "proposal-private-pinned-skia") errors.push("authority");
  if (artifact.arm !== "proposal") errors.push("arm");
  if (artifact.collectionContract.browserLaunches !== 0) errors.push("browser-launches");
  if (artifact.collectionContract.processIsolation !== "one-native-process-per-observation") {
    errors.push("process-isolation");
  }
  if (artifact.collectionContract.equality !== "exact-bytes-no-tolerance") errors.push("equality-contract");
  if (artifact.build.authority !== artifact.authority
      || artifact.build.schemaVersion !== 1
      || artifact.build.chromiumRevision !== SFNS_PINNED_CHROMIUM_REVISION
      || artifact.build.skiaRevision !== SFNS_PINNED_SKIA_REVISION
      || artifact.build.platform !== "darwin") errors.push("build-authority");
  if (!["arm64", "x64"].includes(artifact.build.architecture)
      || artifact.build.binary.path.trim() === ""
      || artifact.build.toolchain.clangPath.trim() === ""
      || artifact.build.toolchain.clangVersion.trim() === ""
      || ![
        "is_debug=false", "is_official_build=true", "skia_use_freetype=false",
        "skia_use_harfbuzz=false", "skia_use_gl=false",
      ].every((flag) => artifact.build.gnArgs.includes(flag))) errors.push("build-contract");
  for (const digest of [
    artifact.build.source.builderSha256, artifact.build.source.cppSha256,
    artifact.build.source.buildGnSha256, artifact.build.toolchain.gnSha256,
    artifact.build.toolchain.ninjaSha256, artifact.build.toolchain.clangSha256,
    artifact.build.binary.sha256, artifact.corpus.sourceArtifactSha256,
  ]) if (!shaValid(digest)) errors.push("build-or-corpus-sha256");
  if (artifact.corpus.sourceArtifact.trim() === "") errors.push("corpus-source-artifact");
  if (!sameNumbers(artifact.corpus.glyphIds, SFNS_GLYPH_IDS)) errors.push("corpus-glyphs");

  const observations = artifact.scenarios.flatMap((scenario) => scenario.observations)
    .concat(artifact.controls.map((control) => control.observation));
  const ids = observations.map((observation) => observation.observationId);
  if (new Set(ids).size !== ids.length || ids.some((id) => id.trim() === "")) {
    errors.push("observation-identity");
  }
  for (const observation of observations) {
    if (observation.buildRuntime.architecture !== artifact.build.architecture
        || !artifact.build.toolchain.clangVersion.includes(observation.buildRuntime.clangVersion)) {
      errors.push(`${observation.observationId}:build-runtime-identity`);
    }
  }

  const byScenario = new Map(artifact.scenarios.map((scenario) => [scenario.id, scenario]));
  if (artifact.scenarios.length !== SFNS_PINNED_SCENARIOS.length) errors.push("scenario-count");
  for (const id of SFNS_PINNED_SCENARIOS) {
    const evidence = byScenario.get(id);
    if (evidence == null) {
      errors.push(`missing-scenario:${id}`);
      continue;
    }
    const expected = EXPECTED_SCENARIOS[id];
    if (evidence.observations.length !== 4) errors.push(`${id}:observation-count`);
    evidence.observations.forEach((observation, index) => {
      validateObservation(observation, id, expected.origins, errors);
      const expectedLifecycle = index < 2 ? "cold" : "warm";
      const expectedOrdinal = index % 2 + 1;
      if (observation.lifecycle !== expectedLifecycle || observation.ordinal !== expectedOrdinal
          || (expectedLifecycle === "cold" ? observation.warmupCount !== 0
            : observation.warmupCount < 1)) errors.push(`${id}:lifecycle:${index}`);
      if (observation.request.fontSize !== expected.fontSize
          || observation.request.deviceScale !== expected.deviceScale
          || observation.request.opsz !== expected.opsz
          || observation.request.baseline !== expected.baseline
          || observation.request.phaseShiftX !== 0
          || observation.request.edging !== "subpixel"
          || observation.request.hinting !== "normal"
          || observation.request.pixelGeometry !== "rgb-h") errors.push(`${id}:request:${index}`);
    });
    const digests = evidence.observations.map(sfnsObservationLogicalDigest);
    if (new Set(digests).size !== 1) errors.push(`${id}:cold-warm-instability`);
    if (evidence.observationLogicalDigest !== digests[0]) errors.push(`${id}:logical-digest`);
    const expectedScale = expected.fontSize * expected.deviceScale;
    for (const observation of evidence.observations) {
      if (!sameNumbers(observation.matrices.scale, [expectedScale, expectedScale])) {
        errors.push(`${id}:factored-scale`);
      }
    }
  }

  const baseline = byScenario.get("zoom-2")?.observations[0];
  const byControl = new Map(artifact.controls.map((control) => [control.id, control]));
  if (artifact.controls.length !== SFNS_CONTROL_IDS.length) errors.push("control-count");
  for (const id of SFNS_CONTROL_IDS) {
    const control = byControl.get(id);
    if (control == null) {
      errors.push(`missing-control:${id}`);
      continue;
    }
    if (control.baselineScenarioId !== "zoom-2") errors.push(`${id}:baseline-scenario`);
    validateObservation(control.observation, "zoom-2", EXPECTED_SCENARIOS["zoom-2"].origins, errors);
    const expected = expectedControlRequest(id);
    if (hashJson(control.observation.request) !== hashJson(expected)) errors.push(`${id}:request`);
    if (control.observation.lifecycle !== "cold" || control.observation.ordinal !== 1
        || control.observation.warmupCount !== 0) errors.push(`${id}:lifecycle`);
    if (baseline != null) {
      const changed = sfnsChangedEvidenceGroups(baseline, control.observation);
      if (hashJson(changed) !== hashJson(control.changedEvidenceGroups)) errors.push(`${id}:changed-groups`);
      for (const group of REQUIRED_CONTROL_GROUPS[id]) {
        if (!changed.includes(group)) errors.push(`${id}:inactive:${group}`);
      }
    }
  }

  if (artifact.artifactDigest !== sfnsPinnedArtifactDigest(artifact)) errors.push("artifact-digest");
  return [...new Set(errors)];
}

export const SFNS_SCENARIO_CONTRACT = EXPECTED_SCENARIOS;
export const SFNS_CONTROL_REQUESTS = CONTROL_REQUESTS;
