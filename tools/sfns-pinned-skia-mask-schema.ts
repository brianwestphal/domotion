/** Fail-closed schema for the independent, proposal-side pinned-Skia arm. */
import { createHash } from "node:crypto";
import {
  SFNS_TERMINAL_MASK_CONTROL_IDS,
  SFNS_TERMINAL_MASK_MANIFEST,
  SFNS_TERMINAL_MASK_MANIFEST_ABI,
  SFNS_TERMINAL_MASK_SCENARIO_IDS,
  sfnsTerminalMaskCase,
  sfnsTerminalMaskManifestDigest,
  type SfnsTerminalMaskCaseId,
  type SfnsTerminalMaskCaseRequest,
  type SfnsTerminalMaskControlId,
  type SfnsTerminalMaskScenarioId,
} from "./sfns-terminal-mask-manifest.js";

export const SFNS_PINNED_CHROMIUM_REVISION =
  "7d859f271cbda744098ac69f44978d4edfa62be3";
export const SFNS_PINNED_SKIA_REVISION =
  "62efacd37737505732dbe3d8daa62abd679626a1";
export const SFNS_PINNED_OTS_REVISION =
  "46bea9879127d0ff1c6601b078e2ce98e83fcd33";
export const SFNS_FONT_PATH = "/System/Library/Fonts/SFNS.ttf";
export const SFNS_FONT_BYTE_LENGTH = 7_909_644;
export const SFNS_FONT_SHA256 =
  "2bfd40dc72e6759e248f82a52a40d551338979fffc9b5c070e685b4b7ad19e66";
export const SFNS_DECODED_FONT_BYTE_LENGTH = 7_806_016;
export const SFNS_DECODED_FONT_SHA256 =
  "48eedcecfc1b0338a2b0deaac43b017df55b3023cff2c5e8ecc87570b4eacff4";
export const SFNS_COLLECTOR_ABI = "domotion-sfns-pinned-skia-mask-v2";
export const SFNS_GLYPH_IDS = SFNS_TERMINAL_MASK_MANIFEST.corpus.glyphIds;
export const SFNS_PINNED_SCENARIOS = SFNS_TERMINAL_MASK_SCENARIO_IDS;
export const SFNS_CONTROL_IDS = SFNS_TERMINAL_MASK_CONTROL_IDS;
export type SfnsPinnedScenarioId = SfnsTerminalMaskScenarioId;
export type SfnsControlId = SfnsTerminalMaskControlId;

export type SfnsNativeRequest = Omit<SfnsTerminalMaskCaseRequest, "browserCss">;

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
  shapedAdvance: number[];
  shapedOffset: number[];
  sourcePosition: number[];
  deviceOrigin: number[];
  mappedWithRounding: number[];
  roundedDeviceOrigin: number[];
  deviceBaseline: number;
  strikeAdvance: number[];
  subpixelOffsetFixed: number[];
  packedId: number;
  phase: { x: number; y: number };
  rounding: {
    halfAxisSampleFreq: number[];
    ignorePositionFieldMask: number[];
  };
  metrics: {
    left: number;
    top: number;
    width: number;
    height: number;
    maskFormat: string;
    rowBytes: number;
    imageSize: number;
  };
  mask: { encoding: "base64"; bytes: string; sha256: string; file: string };
}

export interface SfnsPinnedObservation {
  schemaVersion: 2;
  collectorAbi: string;
  observationId: string;
  caseId: SfnsTerminalMaskCaseId;
  kind: "scenario" | "control";
  scenarioId: SfnsPinnedScenarioId;
  controlId: "" | SfnsControlId;
  lifecycle: "cold" | "warm";
  ordinal: number;
  warmupCount: number;
  source: {
    chromiumRevision: string;
    skiaRevision: string;
    original: { fontPath: string; byteLength: number; sha256: string };
    decoded: {
      authority: "chromium-exact-ots";
      fontPath: string;
      byteLength: number;
      sha256: string;
      collectionIndex: number;
    };
  };
  buildRuntime: { clangVersion: string; architecture: string };
  request: SfnsNativeRequest;
  typeface: {
    uniqueId: number;
    family: string;
    postscriptName: string;
    style: { weight: number; width: number; slant: number };
    axes: Array<{
      tag: string;
      min: number;
      default: number;
      max: number;
      hidden: boolean;
      requested: number;
      actual: number;
    }>;
    fontBytes: {
      authority: "ots-sanitized-sfnt";
      byteLength: number;
      collectionIndex: number;
      sha256: string;
    };
  };
  font: Record<string, unknown>;
  paint: { color: number; style: number };
  surfaceProps: {
    flags: number;
    pixelGeometry: string;
    textContrast: number;
    textGamma: number;
  };
  scalerContextFlags: number;
  rawRec: SfnsRecEvidence;
  filteredRec: SfnsRecEvidence;
  matrices: {
    device: number[];
    total: number[];
    scale: number[];
    remaining: number[];
    remainingWithoutRotation: number[];
    remainingRotation: number[];
    invertible: boolean;
  };
  smoothBehavior: "none" | "some" | "subpixel";
  gamma: {
    inputContrast: number;
    inputDeviceGamma: number;
    tableApplicable: boolean;
    tableWidth: number;
    tableHeight: number;
    tableByteLength: number;
    tableSha256: string;
    tableBytesBase64: string;
    preblendApplicable: boolean;
    preblendByteLength: number;
    preblendR256Sha256: string;
    preblendG256Sha256: string;
    preblendB256Sha256: string;
    preblendR256Base64: string;
    preblendG256Base64: string;
    preblendB256Base64: string;
  };
  coreTextMetrics: {
    raw: {
      pointSize: number;
      unitsPerEm: number;
      ascent: number;
      descent: number;
      leading: number;
      capHeight: number;
      xHeight: number;
      boundingBox: number[];
    };
    normalized: {
      coordinateSystem: "device-y-down";
      baseline: number;
      ascent: number;
      descent: number;
      leading: number;
      capHeight: number;
      xHeight: number;
      top: number;
      bottom: number;
      boundingBox: number[];
    };
  };
  fontMetrics: Record<string, number>;
  glyphs: SfnsMaskGlyph[];
}

export interface SfnsScenarioEvidence {
  id: SfnsPinnedScenarioId;
  request: SfnsTerminalMaskCaseRequest;
  observationLogicalDigest: string;
  observations: [
    SfnsPinnedObservation,
    SfnsPinnedObservation,
    SfnsPinnedObservation,
    SfnsPinnedObservation,
  ];
}

export interface SfnsControlEvidence {
  id: SfnsControlId;
  caseId: `control-${SfnsControlId}`;
  baselineScenarioId: "zoom-2";
  request: SfnsTerminalMaskCaseRequest;
  observation: SfnsPinnedObservation;
  changedEvidenceGroups: string[];
}

export interface SfnsPinnedBuildMetadata {
  schemaVersion: 2;
  authority: "proposal-private-pinned-skia";
  chromiumRevision: string;
  skiaRevision: string;
  depotToolsRevision: string;
  platform: string;
  architecture: string;
  gnArgs: string;
  source: {
    builderSha256: string;
    cppSha256: string;
    buildGnSha256: string;
    manifestSha256: string;
    schemaSha256: string;
    collectorSha256: string;
  };
  toolchain: {
    gnSha256: string;
    ninjaSha256: string;
    clangPath: string;
    clangSha256: string;
    clangVersion: string;
  };
  binary: { path: string; sha256: string };
}

export interface SfnsOtsMetadata {
  schemaVersion: 1;
  authority: "proposal-independent-pinned-chromium-ots";
  platform: string;
  architecture: string;
  revisions: { chromium: string; skia: string; ots: string; depotTools: string };
  contract: {
    context: "pinned-blink-web-font-decoder-table-actions";
    collectionIndex: number;
    processIndexArgument: number;
    maxDecodedBytes: number;
  };
  sourceFont: { path: string; byteLength: number; sha256: string };
  decodedFont: { path: string; byteLength: number; sha256: string };
  sources: Record<string, string>;
  toolchain: Record<string, string>;
  binary: { path: string; sha256: string };
}

export interface SfnsPinnedSkiaProposalArtifact {
  schemaVersion: 2;
  authority: "proposal-private-pinned-skia";
  arm: "proposal";
  manifest: { abi: string; digest: string };
  collectionContract: {
    browserLaunches: 0;
    processIsolation: "one-native-process-per-observation";
    inputDerivation: "source-owned-manifest-independent-arm-derivation";
    equality: "exact-bytes-no-tolerance";
  };
  build: SfnsPinnedBuildMetadata;
  ots: {
    metadataPath: string;
    metadataSha256: string;
    metadataLogicalDigest: string;
    metadata: SfnsOtsMetadata;
  };
  corpus: { text: string; glyphIds: number[]; collectionIndex: number };
  scenarios: SfnsScenarioEvidence[];
  controls: SfnsControlEvidence[];
  artifactDigest: string;
}

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

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function shaBytes(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function exact(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function exactNumbers(actual: unknown, expected: readonly number[]): boolean {
  return Array.isArray(actual) && actual.length === expected.length
    && actual.every((entry, index) => Number.isFinite(entry) && entry === expected[index]);
}

function decodeBase64(value: string): Buffer | null {
  try {
    const bytes = Buffer.from(value, "base64");
    return bytes.toString("base64") === value ? bytes : null;
  } catch {
    return null;
  }
}

function validSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  return exact(Object.keys(value).sort(), [...expected].sort());
}

function nativeRequest(request: SfnsTerminalMaskCaseRequest): SfnsNativeRequest {
  const { browserCss: unused, ...render } = request;
  void unused;
  return render;
}

function mapped(matrix: readonly number[], point: readonly number[]): [number, number] {
  return [
    Math.fround(Math.fround(matrix[0] * point[0])
      + Math.fround(matrix[1] * point[1]) + matrix[2]),
    Math.fround(Math.fround(matrix[3] * point[0])
      + Math.fround(matrix[4] * point[1]) + matrix[5]),
  ];
}

function packedPhase(value: number, fieldMask: number): number {
  const fractional = Math.fround(Math.fround(value - Math.floor(value)) + 1);
  return Math.trunc(Math.fround(fractional * 4)) & fieldMask;
}

function logicalRec(rec: SfnsRecEvidence): SfnsRecEvidence | { invalidBase64: true } {
  const bytes = decodeBase64(rec.bytesBase64);
  if (bytes == null || bytes.length < 4) return { invalidBase64: true };
  bytes.fill(0, 0, 4);
  return {
    ...rec,
    bytesBase64: bytes.toString("base64"),
    sha256: shaBytes(bytes),
  };
}

function observationPayload(observation: SfnsPinnedObservation): unknown {
  return {
    ...observation,
    observationId: undefined,
    lifecycle: undefined,
    ordinal: undefined,
    warmupCount: undefined,
    typeface: { ...observation.typeface, uniqueId: undefined },
    rawRec: logicalRec(observation.rawRec),
    filteredRec: logicalRec(observation.filteredRec),
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
      sourcePosition: glyph.sourcePosition,
      deviceOrigin: glyph.deviceOrigin,
      mappedWithRounding: glyph.mappedWithRounding,
      subpixelOffsetFixed: glyph.subpixelOffsetFixed,
      packedId: glyph.packedId,
      phase: glyph.phase,
    }))),
    mask: hashJson(observation.glyphs.map((glyph) => ({
      metrics: glyph.metrics,
      sha256: glyph.mask.sha256,
    }))),
    rec: hashJson({
      raw: logicalRec(observation.rawRec),
      filtered: logicalRec(observation.filteredRec),
    }),
    matrix: hashJson(observation.matrices),
    axis: hashJson(observation.typeface.axes),
    surface: hashJson(observation.surfaceProps),
    gamma: hashJson(observation.gamma),
    metrics: hashJson(observation.coreTextMetrics),
  };
}

export function sfnsChangedEvidenceGroups(
  baseline: SfnsPinnedObservation,
  candidate: SfnsPinnedObservation,
): string[] {
  const left = sfnsEvidenceGroups(baseline);
  const right = sfnsEvidenceGroups(candidate);
  return Object.keys(left).filter((key) => left[key] !== right[key]).sort();
}

export function sfnsPinnedArtifactDigest(
  artifact: Omit<SfnsPinnedSkiaProposalArtifact, "artifactDigest">
    | SfnsPinnedSkiaProposalArtifact,
): string {
  const { artifactDigest: unused, ...payload } = artifact as SfnsPinnedSkiaProposalArtifact;
  void unused;
  return hashJson(payload);
}

export function sfnsOtsMetadataDigest(metadata: SfnsOtsMetadata): string {
  return hashJson(metadata);
}

function validateEncodedBytes(
  base64: string,
  byteLength: number,
  digest: string,
  label: string,
  errors: string[],
): void {
  const bytes = decodeBase64(base64);
  if (bytes == null) errors.push(`${label}:base64`);
  else {
    if (bytes.length !== byteLength) errors.push(`${label}:byte-length`);
    if (shaBytes(bytes) !== digest) errors.push(`${label}:sha256`);
  }
  if (!validSha(digest)) errors.push(`${label}:sha256-shape`);
}

function validateRec(rec: SfnsRecEvidence, label: string, errors: string[]): void {
  validateEncodedBytes(rec.bytesBase64, rec.byteLength, rec.sha256, label, errors);
  if (rec.byteLength !== 56) errors.push(`${label}:pinned-byte-length`);
  if (!exactNumbers(rec.singleMatrix, rec.singleMatrix) || rec.singleMatrix.length !== 9) {
    errors.push(`${label}:single-matrix`);
  }
}

function recTypefaceId(rec: SfnsRecEvidence): number | null {
  const bytes = decodeBase64(rec.bytesBase64);
  return bytes != null && bytes.length >= 4 ? bytes.readUInt32LE(0) : null;
}

function expectedObservationId(
  caseId: SfnsTerminalMaskCaseId,
  lifecycle: "cold" | "warm",
  ordinal: number,
): string {
  return caseId.startsWith("control-")
    ? `proposal-${caseId}-cold-1`
    : `proposal-${caseId}-${lifecycle}-${ordinal}`;
}

function validateObservation(
  observation: SfnsPinnedObservation,
  caseId: SfnsTerminalMaskCaseId,
  request: SfnsTerminalMaskCaseRequest,
  errors: string[],
): void {
  const label = observation.observationId || `${caseId}:unnamed`;
  const manifestCase = sfnsTerminalMaskCase(caseId);
  if (observation.schemaVersion !== 2) errors.push(`${label}:schema-version`);
  if (observation.collectorAbi !== SFNS_COLLECTOR_ABI) errors.push(`${label}:collector-abi`);
  if (observation.observationId !== expectedObservationId(
    caseId, observation.lifecycle, observation.ordinal,
  )) errors.push(`${label}:arm-qualified-id`);
  if (observation.caseId !== caseId
      || observation.kind !== manifestCase.kind
      || observation.scenarioId !== manifestCase.scenarioId
      || observation.controlId !== manifestCase.controlId) errors.push(`${label}:case-identity`);
  if (!exact(observation.request, nativeRequest(request))) errors.push(`${label}:manifest-request`);
  const manifestDeviceStart = mapped(request.run.liveDeviceMatrix, request.run.sourceStart);
  if (!exactNumbers(request.run.deviceStart, manifestDeviceStart)
      || request.run.deviceBaseline !== request.run.deviceStart[1]) {
    errors.push(`${label}:manifest-coordinate-envelope`);
  }
  if (observation.source.chromiumRevision !== SFNS_PINNED_CHROMIUM_REVISION
      || observation.source.skiaRevision !== SFNS_PINNED_SKIA_REVISION) {
    errors.push(`${label}:source-revisions`);
  }
  if (!exact(observation.source.original, {
    fontPath: SFNS_FONT_PATH,
    byteLength: SFNS_FONT_BYTE_LENGTH,
    sha256: SFNS_FONT_SHA256,
  })) errors.push(`${label}:source-font`);
  if (observation.source.decoded.authority !== "chromium-exact-ots"
      || observation.source.decoded.byteLength !== SFNS_DECODED_FONT_BYTE_LENGTH
      || observation.source.decoded.sha256 !== SFNS_DECODED_FONT_SHA256
      || observation.source.decoded.collectionIndex !== 0
      || observation.source.decoded.fontPath.trim() === "") errors.push(`${label}:decoded-font`);
  if (observation.typeface.fontBytes.authority !== "ots-sanitized-sfnt"
      || observation.typeface.fontBytes.byteLength !== SFNS_DECODED_FONT_BYTE_LENGTH
      || observation.typeface.fontBytes.sha256 !== SFNS_DECODED_FONT_SHA256
      || observation.typeface.fontBytes.collectionIndex !== 0) errors.push(`${label}:typeface-font-bytes`);
  if (observation.typeface.uniqueId <= 0
      || observation.typeface.family !== ".SF NS"
      || observation.typeface.postscriptName !== (request.axes.opsz === 26
        ? ".SFNS-Regular_wdth_opsz1A0000_GRAD_wght2BC0000"
        : ".SFNS-Bold")
      || !exact(observation.typeface.style, { weight: 700, width: 5, slant: 0 })) {
    errors.push(`${label}:typeface-identity`);
  }
  const expectedAxes: Record<string, [number, number, number, boolean, number]> = {
    wdth: [30, 100, 150, false, request.axes.wdth],
    opsz: [17, 28, 96, false, request.axes.opsz],
    GRAD: [400, 400, 1000, true, request.axes.GRAD],
    wght: [1, 400, 1000, false, request.axes.wght],
  };
  const axes = new Map(observation.typeface.axes.map((axis) => [axis.tag, axis]));
  if (axes.size !== 4 || observation.typeface.axes.length !== 4) errors.push(`${label}:axis-count`);
  for (const [tag, expected] of Object.entries(expectedAxes)) {
    const axis = axes.get(tag);
    if (axis == null || !exact(
      [axis.min, axis.default, axis.max, axis.hidden, axis.requested, axis.actual],
      [...expected, expected[4]],
    )) errors.push(`${label}:axis:${tag}`);
  }
  if (!exact(observation.font, {
    size: request.fontSize,
    ...request.font,
  })) errors.push(`${label}:font`);
  if (!exact(observation.paint, { color: 0xffff_ffff, style: 0 })) errors.push(`${label}:paint-white`);
  if (!exact(observation.surfaceProps, request.surface)) errors.push(`${label}:surface`);
  if (observation.scalerContextFlags !== request.scalerContextFlags) {
    errors.push(`${label}:scaler-context-flags`);
  }
  validateRec(observation.rawRec, `${label}:raw-rec`, errors);
  validateRec(observation.filteredRec, `${label}:filtered-rec`, errors);
  if (recTypefaceId(observation.rawRec) !== observation.typeface.uniqueId
      || recTypefaceId(observation.filteredRec) !== observation.typeface.uniqueId) {
    errors.push(`${label}:rec-typeface-identity`);
  }
  const effectiveScale = request.fontSize * request.run.liveDeviceMatrix[0];
  const scaledIdentity = [effectiveScale, 0, 0, 0, effectiveScale, 0, 0, 0, 1];
  const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  if (!observation.matrices.invertible
      || !exactNumbers(observation.matrices.device, request.run.liveDeviceMatrix)
      || !exactNumbers(observation.matrices.total, scaledIdentity)
      || !exactNumbers(observation.matrices.scale, [effectiveScale, effectiveScale])
      || !exactNumbers(observation.matrices.remaining, identity)
      || !exactNumbers(observation.matrices.remainingWithoutRotation, identity)
      || !exactNumbers(observation.matrices.remainingRotation, identity)
      || !exactNumbers(observation.rawRec.singleMatrix, scaledIdentity)
      || !exactNumbers(observation.filteredRec.singleMatrix, scaledIdentity)) {
    errors.push(`${label}:matrix-factorization`);
  }
  const expectedRawFormat = request.font.edging === "subpixel"
    && request.surface.pixelGeometry !== "unknown" ? "LCD16" : "A8";
  const expectedFilteredFormat = expectedRawFormat === "LCD16"
    && observation.smoothBehavior === "subpixel" ? "LCD16" : "A8";
  if (observation.rawRec.textSize !== request.fontSize
      || observation.filteredRec.textSize !== request.fontSize
      || observation.rawRec.maskFormat !== expectedRawFormat
      || observation.filteredRec.maskFormat !== expectedFilteredFormat) {
    errors.push(`${label}:rec-route`);
  }
  const tableLength = observation.gamma.tableApplicable ? observation.gamma.tableByteLength : 0;
  validateEncodedBytes(
    observation.gamma.tableBytesBase64,
    tableLength,
    observation.gamma.tableSha256,
    `${label}:gamma-table`,
    errors,
  );
  for (const channel of ["R", "G", "B"] as const) {
    validateEncodedBytes(
      observation.gamma[`preblend${channel}256Base64`],
      observation.gamma.preblendApplicable ? observation.gamma.preblendByteLength : 0,
      observation.gamma[`preblend${channel}256Sha256`],
      `${label}:preblend-${channel.toLowerCase()}`,
      errors,
    );
  }
  if (observation.gamma.inputContrast !== request.surface.textContrast
      || observation.gamma.inputDeviceGamma !== request.surface.textGamma
      || !observation.gamma.tableApplicable
      || observation.gamma.tableWidth !== 256
      || observation.gamma.tableHeight !== 8
      || observation.gamma.tableByteLength !== 2_048
      || !observation.gamma.preblendApplicable
      || observation.gamma.preblendByteLength !== 256) {
    errors.push(`${label}:gamma-input-contract`);
  }
  const rawMetrics = observation.coreTextMetrics.raw;
  const normalized = observation.coreTextMetrics.normalized;
  const metricScale = effectiveScale / 26;
  const expectedRawMetrics = {
    pointSize: effectiveScale,
    unitsPerEm: 2048,
    ascent: 25.13671875 * metricScale,
    descent: 5.484375 * metricScale,
    leading: 0,
    capHeight: 18.3193359375 * metricScale,
    xHeight: (request.axes.opsz === 26 ? 13.6474609375 : 13.9775390625) * metricScale,
    boundingBox: [
      -16.783203125 * metricScale,
      -7.16015625 * metricScale,
      80.89453125 * metricScale,
      32.04296875 * metricScale,
    ],
  };
  if (!exact(rawMetrics, expectedRawMetrics)
      || ![rawMetrics.ascent, rawMetrics.descent, rawMetrics.leading, rawMetrics.capHeight,
        rawMetrics.xHeight].every(Number.isFinite)
      || !exactNumbers(rawMetrics.boundingBox, rawMetrics.boundingBox)
      || rawMetrics.boundingBox.length !== 4
      || normalized.coordinateSystem !== "device-y-down"
      || normalized.baseline !== request.run.deviceBaseline
      || normalized.ascent !== -rawMetrics.ascent
      || normalized.descent !== rawMetrics.descent
      || normalized.leading !== rawMetrics.leading
      || normalized.capHeight !== -rawMetrics.capHeight
      || normalized.xHeight !== -rawMetrics.xHeight
      || normalized.top !== request.run.deviceBaseline - rawMetrics.ascent
      || normalized.bottom !== request.run.deviceBaseline + rawMetrics.descent
      || !exactNumbers(normalized.boundingBox, [
        rawMetrics.boundingBox[0],
        -(rawMetrics.boundingBox[1] + rawMetrics.boundingBox[3]),
        rawMetrics.boundingBox[2],
        rawMetrics.boundingBox[3],
      ])) errors.push(`${label}:coretext-normalization`);
  if (!Object.values(observation.fontMetrics).every(Number.isFinite)) {
    errors.push(`${label}:font-metrics`);
  }
  if (observation.glyphs.length !== SFNS_GLYPH_IDS.length) errors.push(`${label}:glyph-count`);
  let expectedSourceX = request.run.sourceStart[0];
  observation.glyphs.forEach((glyph, index) => {
    const glyphLabel = `${label}:glyph:${index}`;
    const expectedSource = [expectedSourceX, request.run.sourceStart[1]];
    const expectedDevice = mapped(request.run.liveDeviceMatrix, expectedSource);
    const expectedRoundedInput = [
      Math.fround(expectedDevice[0] + glyph.rounding.halfAxisSampleFreq[0]),
      Math.fround(expectedDevice[1] + glyph.rounding.halfAxisSampleFreq[1]),
    ];
    if (glyph.index !== index || glyph.gid !== SFNS_GLYPH_IDS[index]
        || !exactNumbers(glyph.shapedOffset, [0, 0])
        || glyph.shapedAdvance.length !== 2 || glyph.shapedAdvance[1] !== 0
        || !exactNumbers(glyph.sourcePosition, expectedSource)
        || !exactNumbers(glyph.deviceOrigin, expectedDevice)
        || !exactNumbers(glyph.mappedWithRounding, expectedRoundedInput)
        || !exactNumbers(glyph.roundedDeviceOrigin, [
          Math.floor(expectedRoundedInput[0]), Math.floor(expectedRoundedInput[1]),
        ])
        || glyph.deviceBaseline !== request.run.deviceBaseline
        || !exactNumbers(glyph.rounding.halfAxisSampleFreq, [0.125, 0.5])
        || !exactNumbers(glyph.rounding.ignorePositionFieldMask, [3, 0])) {
      errors.push(`${glyphLabel}:derived-run`);
    }
    const expectedPhaseX = packedPhase(
      expectedRoundedInput[0], glyph.rounding.ignorePositionFieldMask[0],
    );
    const expectedPhaseY = packedPhase(
      expectedRoundedInput[1], glyph.rounding.ignorePositionFieldMask[1],
    );
    const expectedPackedId = ((glyph.gid << 2) | expectedPhaseX | (expectedPhaseY << 18)) >>> 0;
    if (glyph.packedId !== expectedPackedId
        || ((glyph.packedId >>> 2) & 0xffff) !== glyph.gid
        || glyph.phase.x !== expectedPhaseX
        || glyph.phase.y !== expectedPhaseY
        || glyph.phase.x !== (glyph.packedId & 3)
        || glyph.phase.y !== ((glyph.packedId >>> 18) & 3)
        || !exactNumbers(glyph.subpixelOffsetFixed, [
          glyph.phase.x << 14, glyph.phase.y << 14,
        ])) errors.push(`${glyphLabel}:packed-phase`);
    if (glyph.strikeAdvance.length !== 2
        || !glyph.strikeAdvance.every(Number.isFinite)) errors.push(`${glyphLabel}:strike-advance`);
    if (![glyph.metrics.left, glyph.metrics.top, glyph.metrics.width, glyph.metrics.height,
      glyph.metrics.rowBytes, glyph.metrics.imageSize].every(Number.isFinite)
      || glyph.metrics.width < 0 || glyph.metrics.height < 0
      || glyph.metrics.imageSize !== glyph.metrics.rowBytes * glyph.metrics.height
      || glyph.metrics.maskFormat !== observation.filteredRec.maskFormat) {
      errors.push(`${glyphLabel}:mask-metrics`);
    }
    validateEncodedBytes(
      glyph.mask.bytes,
      glyph.metrics.imageSize,
      glyph.mask.sha256,
      `${glyphLabel}:mask`,
      errors,
    );
    if (glyph.mask.encoding !== "base64"
        || glyph.mask.file !== `${observation.observationId}-gid-${glyph.gid}-${index}.mask`) {
      errors.push(`${glyphLabel}:mask-envelope`);
    }
    expectedSourceX = Math.fround(expectedSourceX + glyph.shapedAdvance[0]);
  });
}

const REQUIRED_CONTROL_GROUPS: Record<SfnsControlId, readonly string[]> = {
  "subpixel-phase": ["phase", "mask"],
  "anti-aliasing": ["request", "rec"],
  hinting: ["request", "rec"],
  "device-matrix": ["matrix", "metrics", "mask"],
  "optical-size": ["axis", "mask"],
  "surface-mask-format": ["surface", "rec"],
};

function validateSfnsPinnedSkiaProposalImpl(
  artifact: SfnsPinnedSkiaProposalArtifact,
): string[] {
  const errors: string[] = [];
  if (artifact.schemaVersion !== 2) errors.push("schema-version");
  if (artifact.authority !== "proposal-private-pinned-skia" || artifact.arm !== "proposal") {
    errors.push("authority-arm");
  }
  if (!exact(artifact.manifest, {
    abi: SFNS_TERMINAL_MASK_MANIFEST_ABI,
    digest: sfnsTerminalMaskManifestDigest(),
  })) errors.push("manifest-identity");
  if (!exact(artifact.collectionContract, {
    browserLaunches: 0,
    processIsolation: "one-native-process-per-observation",
    inputDerivation: "source-owned-manifest-independent-arm-derivation",
    equality: "exact-bytes-no-tolerance",
  })) errors.push("collection-contract");
  if (artifact.build.schemaVersion !== 2
      || artifact.build.authority !== artifact.authority
      || artifact.build.chromiumRevision !== SFNS_PINNED_CHROMIUM_REVISION
      || artifact.build.skiaRevision !== SFNS_PINNED_SKIA_REVISION
      || artifact.build.depotToolsRevision !==
        "612d70c7ccb01d4a405e822ad0505206de636d7e"
      || artifact.build.platform !== "darwin") errors.push("build-identity");
  if (!["arm64", "x64"].includes(artifact.build.architecture)
      || !["is_debug=false", "is_official_build=true", "skia_use_freetype=false"]
        .every((flag) => artifact.build.gnArgs.includes(flag))
      || artifact.build.binary.path.trim() === ""
      || artifact.build.toolchain.clangPath.trim() === ""
      || artifact.build.toolchain.clangVersion.trim() === "") errors.push("build-contract");
  const buildDigests = [
    ...Object.values(artifact.build.source),
    artifact.build.toolchain.gnSha256,
    artifact.build.toolchain.ninjaSha256,
    artifact.build.toolchain.clangSha256,
    artifact.build.binary.sha256,
  ];
  if (!exactKeys(artifact.build.source, [
    "builderSha256", "cppSha256", "buildGnSha256", "manifestSha256",
    "schemaSha256", "collectorSha256",
  ]) || !buildDigests.every(validSha)) errors.push("build-digests");
  if (!validSha(artifact.ots.metadataSha256)
      || artifact.ots.metadataLogicalDigest !== sfnsOtsMetadataDigest(artifact.ots.metadata)
      || artifact.ots.metadataPath.trim() === "") errors.push("ots-metadata-envelope");
  const ots = artifact.ots.metadata;
  if (ots.schemaVersion !== 1
      || ots.authority !== "proposal-independent-pinned-chromium-ots"
      || ots.platform !== "darwin"
      || ots.architecture !== artifact.build.architecture
      || ots.revisions.chromium !== SFNS_PINNED_CHROMIUM_REVISION
      || ots.revisions.skia !== SFNS_PINNED_SKIA_REVISION
      || ots.revisions.ots !== SFNS_PINNED_OTS_REVISION
      || ots.revisions.depotTools !==
        "612d70c7ccb01d4a405e822ad0505206de636d7e"
      || ots.contract.context !== "pinned-blink-web-font-decoder-table-actions"
      || ots.contract.collectionIndex !== 0 || ots.contract.processIndexArgument !== -1
      || ots.contract.maxDecodedBytes !== 128 * 1024 * 1024
      || ots.sourceFont.byteLength !== SFNS_FONT_BYTE_LENGTH
      || ots.sourceFont.sha256 !== SFNS_FONT_SHA256
      || ots.sourceFont.path !== SFNS_FONT_PATH
      || ots.decodedFont.byteLength !== SFNS_DECODED_FONT_BYTE_LENGTH
      || ots.decodedFont.sha256 !== SFNS_DECODED_FONT_SHA256
      || ots.decodedFont.path.trim() === ""
      || !validSha(ots.binary.sha256)
      || ots.binary.path.trim() === ""
      || ots.binary.sha256 === artifact.build.binary.sha256
      || !exactKeys(ots.sources, [
        "builderSha256", "sanitizerCppSha256", "sanitizerBuildGnSha256",
        "chromiumOtsBuildGnSha256", "otsImplementationSha256",
        "otsPublicHeaderSha256", "otsMemoryStreamSha256", "blinkWebFontDecoderSha256",
      ])
      || !Object.values(ots.sources).every(validSha)
      || !exactKeys(ots.toolchain, [
        "gnSha256", "ninjaWrapperSha256", "clangPath", "clangSha256",
        "clangVersion", "gnArgsSha256",
      ])
      || ![ots.toolchain.gnSha256, ots.toolchain.ninjaWrapperSha256,
        ots.toolchain.clangSha256, ots.toolchain.gnArgsSha256].every(validSha)
      || ots.toolchain.clangPath.trim() === ""
      || ots.toolchain.clangVersion.trim() === "") errors.push("ots-authentication");
  if (!exact(artifact.corpus, {
    text: SFNS_TERMINAL_MASK_MANIFEST.corpus.text,
    glyphIds: [...SFNS_GLYPH_IDS],
    collectionIndex: 0,
  })) errors.push("corpus");

  const scenarioMap = new Map(artifact.scenarios.map((entry) => [entry.id, entry]));
  if (scenarioMap.size !== SFNS_PINNED_SCENARIOS.length
      || artifact.scenarios.length !== SFNS_PINNED_SCENARIOS.length) errors.push("scenario-count");
  for (const id of SFNS_PINNED_SCENARIOS) {
    const entry = scenarioMap.get(id);
    const request = sfnsTerminalMaskCase(id).request;
    if (entry == null) { errors.push(`missing-scenario:${id}`); continue; }
    if (!exact(entry.request, request)) errors.push(`${id}:manifest-request`);
    if (entry.observations.length !== 4) errors.push(`${id}:observation-count`);
    entry.observations.forEach((observation, index) => {
      validateObservation(observation, id, request, errors);
      const lifecycle = index < 2 ? "cold" : "warm";
      const ordinal = index % 2 + 1;
      if (observation.lifecycle !== lifecycle || observation.ordinal !== ordinal
          || observation.warmupCount !== (lifecycle === "cold" ? 0 : 1)) {
        errors.push(`${id}:lifecycle:${index}`);
      }
    });
    const digests = entry.observations.map(sfnsObservationLogicalDigest);
    if (new Set(digests).size !== 1) errors.push(`${id}:cold-warm-instability`);
    if (entry.observationLogicalDigest !== digests[0]) errors.push(`${id}:logical-digest`);
  }

  const baseline = scenarioMap.get("zoom-2")?.observations[0];
  const controlMap = new Map(artifact.controls.map((entry) => [entry.id, entry]));
  if (controlMap.size !== SFNS_CONTROL_IDS.length
      || artifact.controls.length !== SFNS_CONTROL_IDS.length) errors.push("control-count");
  for (const id of SFNS_CONTROL_IDS) {
    const entry = controlMap.get(id);
    const caseId = `control-${id}` as const;
    const request = sfnsTerminalMaskCase(caseId).request;
    if (entry == null) { errors.push(`missing-control:${id}`); continue; }
    if (entry.caseId !== caseId || entry.baselineScenarioId !== "zoom-2"
        || !exact(entry.request, request)) errors.push(`${id}:manifest-request`);
    validateObservation(entry.observation, caseId, request, errors);
    if (entry.observation.lifecycle !== "cold" || entry.observation.ordinal !== 1
        || entry.observation.warmupCount !== 0) errors.push(`${id}:lifecycle`);
    if (baseline != null) {
      const changed = sfnsChangedEvidenceGroups(baseline, entry.observation);
      if (!exact(entry.changedEvidenceGroups, changed)) errors.push(`${id}:changed-groups`);
      for (const group of REQUIRED_CONTROL_GROUPS[id]) {
        if (!changed.includes(group)) errors.push(`${id}:inactive:${group}`);
      }
    }
  }
  const observations = artifact.scenarios.flatMap((entry) => entry.observations)
    .concat(artifact.controls.map((entry) => entry.observation));
  if (new Set(observations.map((entry) => entry.observationId)).size !== 26) {
    errors.push("observation-identity");
  }
  for (const observation of observations) {
    if (observation.buildRuntime.architecture !== artifact.build.architecture
        || !artifact.build.toolchain.clangVersion.includes(observation.buildRuntime.clangVersion)) {
      errors.push(`${observation.observationId}:build-runtime-identity`);
    }
  }
  if (artifact.artifactDigest !== sfnsPinnedArtifactDigest(artifact)) errors.push("artifact-digest");
  return [...new Set(errors)];
}

export function validateSfnsPinnedSkiaProposal(
  artifact: SfnsPinnedSkiaProposalArtifact,
): string[] {
  try {
    return validateSfnsPinnedSkiaProposalImpl(artifact);
  } catch (error) {
    return [`malformed-artifact:${error instanceof Error ? error.message : String(error)}`];
  }
}

// Compatibility exports used by the adjudicator while validation v2 is collected in DM-2587.
export const SFNS_SCENARIO_CONTRACT = Object.fromEntries(SFNS_PINNED_SCENARIOS.map((id) => {
  const request = sfnsTerminalMaskCase(id).request;
  return [id, {
    fontSize: request.fontSize,
    deviceScale: request.run.liveDeviceMatrix[0],
    opsz: request.axes.opsz,
    baseline: request.run.deviceBaseline,
    origins: [],
  }];
})) as Record<SfnsPinnedScenarioId, {
  fontSize: number; deviceScale: number; opsz: number; baseline: number; origins: number[];
}>;
export const SFNS_CONTROL_REQUESTS = {} as Record<SfnsControlId, never>;
