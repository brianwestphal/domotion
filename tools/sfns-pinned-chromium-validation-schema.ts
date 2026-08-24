/** Fail-closed schema for the test-only pinned-Chromium SFNS validation arm. */
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

export const SFNS_VALIDATION_CHROMIUM_REVISION =
  "7d859f271cbda744098ac69f44978d4edfa62be3";
export const SFNS_VALIDATION_SKIA_REVISION =
  "62efacd37737505732dbe3d8daa62abd679626a1";
export const SFNS_VALIDATION_DEPOT_TOOLS_REVISION =
  "612d70c7ccb01d4a405e822ad0505206de636d7e";
export const SFNS_VALIDATION_FONT_SHA256 =
  "2bfd40dc72e6759e248f82a52a40d551338979fffc9b5c070e685b4b7ad19e66";
export const SFNS_VALIDATION_FONT_BYTE_LENGTH = 7_909_644;
export const SFNS_VALIDATION_DECODED_FONT_SHA256 =
  "48eedcecfc1b0338a2b0deaac43b017df55b3023cff2c5e8ecc87570b4eacff4";
export const SFNS_VALIDATION_DECODED_FONT_BYTE_LENGTH = 7_806_016;
export const SFNS_VALIDATION_HOOK_ABI = "domotion-sfns-pinned-chromium-hook-v2";
export const SFNS_VALIDATION_GN_ARGS = [
  "is_debug = false",
  "is_component_build = false",
  "symbol_level = 0",
  "blink_symbol_level = 0",
  "v8_symbol_level = 0",
  "use_remoteexec = false",
  "use_siso = false",
  "treat_warnings_as_errors = false",
  "sk_domotion_sfns_validation_hook = true",
  "blink_domotion_sfns_validation_hook = true",
  "",
].join("\n");
export const SFNS_VALIDATION_GLYPH_IDS = SFNS_TERMINAL_MASK_MANIFEST.corpus.glyphIds;
export const SFNS_VALIDATION_SCENARIOS = SFNS_TERMINAL_MASK_SCENARIO_IDS;
export type SfnsValidationScenarioId = SfnsTerminalMaskScenarioId;
export const SFNS_VALIDATION_CONTROLS = SFNS_TERMINAL_MASK_CONTROL_IDS;
export type SfnsValidationControlId = SfnsTerminalMaskControlId;

export interface SfnsValidationRec {
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

export interface SfnsValidationTypeface {
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
    actual: number | null;
  }>;
  fontBytes: {
    authority: "ots-sanitized-sfnt";
    byteLength: number;
    collectionIndex: number;
    sha256: string;
  };
}

export interface SfnsRawPayload {
  font: Record<string, unknown>;
  paint: Record<string, unknown>;
  surfaceProps: Record<string, unknown>;
  scalerContextFlags: number;
  deviceMatrix: number[];
  rawRec: SfnsValidationRec;
  matrices: SfnsValidationMatrices;
}

export interface SfnsFilteredPayload {
  before: SfnsValidationRec;
  after: SfnsValidationRec;
  matrices: SfnsValidationMatrices;
  smoothBehavior: string;
}

export interface SfnsShapeGlyph {
  index: number;
  gid: number;
  characterIndex: number;
  shapedAdvance: number[];
  shapedOffset: number[];
  accumulatedAdvance: number[];
  horizontal: boolean;
}

export interface SfnsShapePayload {
  coordinateSystem: "skia-source-space-y-down";
  glyphs: SfnsShapeGlyph[];
}

export interface SfnsGammaPayload {
  filteredRec: SfnsValidationRec;
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
}

export interface SfnsRunGlyph {
  index: number;
  gid: number;
  sourcePosition: number[];
  deviceOrigin: number[];
  mappedWithRounding: number[];
  roundedDeviceOrigin: number[];
  packedId: number;
  phase: { x: number; y: number };
}

export interface SfnsRunPayload {
  font: Record<string, unknown>;
  surfaceProps: Record<string, unknown>;
  scalerContextFlags: number;
  positionMatrix: number[];
  rounding: { halfAxisSampleFreq: number[]; ignorePositionFieldMask: number[] };
  glyphs: SfnsRunGlyph[];
}

export interface SfnsMaskPayload {
  filteredRec: SfnsValidationRec;
  matrices: SfnsValidationMatrices;
  coreText: Record<string, unknown>;
  transform: number[];
  inverseTransform: number[];
  requestSmooth: boolean;
  smoothBehavior: string;
  gamma: Record<string, unknown>;
  glyph: {
    gid: number;
    advance: number[];
    subpixelOffsetFixed: number[];
    packedId: number;
    phase: { x: number; y: number };
    metrics: {
      left: number;
      top: number;
      width: number;
      height: number;
      maskFormat: string;
      rowBytes: number;
      imageSize: number;
    };
    mask: { encoding: "base64"; bytes: string; sha256: string };
  };
}

export interface SfnsValidationMatrices {
  total: number[];
  scale: number[];
  remaining: number[];
  remainingWithoutRotation: number[];
  remainingRotation: number[];
  invertible: boolean;
}

export type SfnsHookEventName = "shape" | "raw" | "filtered" | "gamma" | "run" | "mask";
export type SfnsHookPayload =
  SfnsShapePayload | SfnsRawPayload | SfnsFilteredPayload | SfnsGammaPayload
  | SfnsRunPayload | SfnsMaskPayload;

export interface SfnsHookEvent {
  schemaVersion: 2;
  hookAbi: string;
  sequence: number;
  event: SfnsHookEventName;
  observationId: string;
  scenarioId: string;
  lifecycle: "cold" | "warm" | "control";
  controlId: string;
  ordinal: number;
  processId: number;
  source: {
    chromiumRevision: string;
    skiaRevision: string;
    sourceFontByteLength: number;
    sourceFontSha256: string;
    decodedFontByteLength: number;
    decodedFontSha256: string;
  };
  typeface: SfnsValidationTypeface;
  payload: SfnsHookPayload;
}

export interface SfnsValidationBrowserFacts {
  explicitlyHeadless: true;
  launchArgs: string[];
  version: string;
  userAgent: string;
  screenshotSha256: string;
  platformFonts: Array<{
    familyName: string;
    postScriptName: string;
    isCustomFont: boolean;
    glyphCount: number;
  }>;
  css: {
    fontSize: string;
    fontFamily: string;
    fontVariationSettings: string;
    fontOpticalSizing: string;
    fontSmoothing: string;
    textRendering: string;
    transform: string;
    zoom: string;
  };
  range: { x: number; y: number; width: number; height: number };
}

export interface SfnsValidationCoreTextMetrics {
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
}

export interface SfnsValidationObservation {
  observationId: string;
  caseId: SfnsTerminalMaskCaseId;
  kind: "scenario" | "control";
  scenarioId: SfnsValidationScenarioId;
  lifecycle: "cold" | "warm" | "control";
  controlId: string;
  ordinal: number;
  browser: SfnsValidationBrowserFacts;
  coordinateSpace: {
    source: "skia-source-space-y-down";
    device: "device-space-y-down";
    coreTextRaw: "coretext-y-up";
    normalized: "device-y-down";
    mask: "glyph-device-space-y-down";
  };
  coreTextMetrics: SfnsValidationCoreTextMetrics;
  events: SfnsHookEvent[];
  selection: {
    processId: number;
    shapeSequence: number;
    rawSequence: number;
    filteredSequence: number;
    gammaSequence: number;
    runSequence: number;
    maskSequences: number[];
  };
  logicalDigest: string;
}

export interface SfnsPinnedChromiumValidationArtifact {
  schemaVersion: 2;
  authority: "validation-test-only-pinned-chromium";
  arm: "validation";
  manifest: { abi: string; digest: string };
  collectionContract: {
    browserLaunches: 26;
    processIsolation: "one-explicitly-headless-browser-per-observation";
    inputDerivation: "source-owned-manifest-independent-arm-derivation";
    equality: "exact-bytes-no-tolerance";
    productionRenderingChanges: false;
  };
  build: {
    chromiumRevision: string;
    skiaRevision: string;
    depotToolsRevision: string;
    platform: string;
    architecture: string;
    gnArgs: string;
    binary: { path: string; sha256: string };
    sources: Record<string, string>;
    toolchain: Record<string, string>;
    hostComponents: Record<string, string>;
  };
  corpus: {
    text: string;
    fontPath: string;
    sourceFontByteLength: number;
    sourceFontSha256: string;
    decodedFontByteLength: number;
    decodedFontSha256: string;
    collectionIndex: number;
    glyphIds: number[];
  };
  scenarios: Array<{
    id: SfnsValidationScenarioId;
    request: SfnsTerminalMaskCaseRequest;
    observationLogicalDigest: string;
    observations: SfnsValidationObservation[];
  }>;
  controls: Array<{
    id: SfnsValidationControlId;
    caseId: `control-${SfnsValidationControlId}`;
    baselineScenarioId: "zoom-2";
    request: SfnsTerminalMaskCaseRequest;
    observation: SfnsValidationObservation;
    changedEvidenceGroups: string[];
  }>;
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
  const serialized = JSON.stringify(canonicalize(value));
  return createHash("sha256").update(serialized ?? "undefined").digest("hex");
}

function exact(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function shaBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function validSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function exactNumbers(actual: unknown, expected: readonly number[]): boolean {
  return Array.isArray(actual) && actual.length === expected.length
    && actual.every((value, index) => Number.isFinite(value) && value === expected[index]);
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

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return hashJson(Object.keys(value).sort()) === hashJson([...expected].sort());
}

function decodeExactBase64(value: string): Buffer | null {
  try {
    const decoded = Buffer.from(value, "base64");
    return decoded.toString("base64") === value ? decoded : null;
  } catch {
    return null;
  }
}

function validateEncodedBytes(
  base64: string,
  byteLength: number,
  digest: string,
  label: string,
  errors: string[],
): void {
  const bytes = decodeExactBase64(base64);
  if (bytes == null) errors.push(`${label}:base64`);
  else {
    if (bytes.length !== byteLength) errors.push(`${label}:byte-length`);
    if (shaBytes(bytes) !== digest) errors.push(`${label}:sha256`);
  }
  if (!validSha(digest)) errors.push(`${label}:sha256-shape`);
}

function expectedObservationId(
  caseId: SfnsTerminalMaskCaseId,
  lifecycle: "cold" | "warm" | "control",
  ordinal: number,
): string {
  return caseId.startsWith("control-")
    ? `validation-${caseId}-1`
    : `validation-${caseId}-${lifecycle}-${ordinal}`;
}

// SkScalerContextRec starts with a process-local SkTypefaceID. Preserve and
// authenticate the exact emitted bytes in every observation, but remove those
// first four runtime-identity bytes from lifecycle/control logical digests.
// Cross-process and event/typeface identity are enforced separately below.
function withoutRuntimeRecIdentity(rec: SfnsValidationRec): SfnsValidationRec {
  const bytes = decodeExactBase64(rec.bytesBase64);
  if (bytes == null || bytes.length < 4) return rec;
  bytes.fill(0, 0, 4);
  return {
    ...rec,
    bytesBase64: bytes.toString("base64"),
    sha256: shaBytes(bytes),
  };
}

function recTypefaceId(rec: SfnsValidationRec): number | null {
  const bytes = decodeExactBase64(rec.bytesBase64);
  return bytes != null && bytes.length >= 4 ? bytes.readUInt32LE(0) : null;
}

function withoutRuntimePayload(event: SfnsHookEvent): SfnsHookPayload {
  switch (event.event) {
    case "raw": {
      const payload = event.payload as SfnsRawPayload;
      return { ...payload, rawRec: withoutRuntimeRecIdentity(payload.rawRec) };
    }
    case "filtered": {
      const payload = event.payload as SfnsFilteredPayload;
      return {
        ...payload,
        before: withoutRuntimeRecIdentity(payload.before),
        after: withoutRuntimeRecIdentity(payload.after),
      };
    }
    case "gamma": {
      const payload = event.payload as SfnsGammaPayload;
      return { ...payload, filteredRec: withoutRuntimeRecIdentity(payload.filteredRec) };
    }
    case "mask": {
      const payload = event.payload as SfnsMaskPayload;
      return { ...payload, filteredRec: withoutRuntimeRecIdentity(payload.filteredRec) };
    }
    case "shape":
    case "run":
      return event.payload;
  }
}

function eventAt(observation: SfnsValidationObservation, sequence: number): SfnsHookEvent | undefined {
  return observation.events.find((event) => event.sequence === sequence);
}

function selected(observation: SfnsValidationObservation): {
  shape?: SfnsHookEvent;
  raw?: SfnsHookEvent;
  filtered?: SfnsHookEvent;
  gamma?: SfnsHookEvent;
  run?: SfnsHookEvent;
  masks: SfnsHookEvent[];
} {
  return {
    shape: eventAt(observation, observation.selection.shapeSequence),
    raw: eventAt(observation, observation.selection.rawSequence),
    filtered: eventAt(observation, observation.selection.filteredSequence),
    gamma: eventAt(observation, observation.selection.gammaSequence),
    run: eventAt(observation, observation.selection.runSequence),
    masks: observation.selection.maskSequences
      .map((sequence) => eventAt(observation, sequence)).filter((event): event is SfnsHookEvent => event != null),
  };
}

function withoutRuntimeTypeface(typeface: SfnsValidationTypeface): unknown {
  return { ...typeface, uniqueId: undefined };
}

export function sfnsValidationObservationDigest(observation: SfnsValidationObservation): string {
  const evidence = selected(observation);
  const strip = (event: SfnsHookEvent | undefined): unknown => event == null ? null : ({
    event: event.event,
    source: event.source,
    typeface: withoutRuntimeTypeface(event.typeface),
    payload: withoutRuntimePayload(event),
  });
  return hashJson({
    caseId: observation.caseId,
    scenarioId: observation.scenarioId,
    browser: observation.browser,
    coordinateSpace: observation.coordinateSpace,
    coreTextMetrics: observation.coreTextMetrics,
    shape: strip(evidence.shape),
    raw: strip(evidence.raw),
    filtered: strip(evidence.filtered),
    gamma: strip(evidence.gamma),
    run: strip(evidence.run),
    masks: evidence.masks.map(strip),
  });
}

export function sfnsValidationEvidenceGroups(
  observation: SfnsValidationObservation,
): Record<string, string> {
  const evidence = selected(observation);
  const shape = evidence.shape?.payload as SfnsShapePayload | undefined;
  const raw = evidence.raw?.payload as SfnsRawPayload | undefined;
  const filtered = evidence.filtered?.payload as SfnsFilteredPayload | undefined;
  const gamma = evidence.gamma?.payload as SfnsGammaPayload | undefined;
  const run = evidence.run?.payload as SfnsRunPayload | undefined;
  const masks = evidence.masks.map((event) => event.payload as SfnsMaskPayload);
  return {
    request: hashJson(sfnsTerminalMaskCase(observation.caseId).request),
    shape: hashJson(shape),
    phase: hashJson(run?.glyphs.map((glyph) => ({ packedId: glyph.packedId, phase: glyph.phase }))),
    mask: hashJson(masks.map((mask) => ({
      packedId: mask.glyph.packedId,
      metrics: mask.glyph.metrics,
      sha256: mask.glyph.mask.sha256,
    }))),
    raw: hashJson(raw == null ? null : {
      ...raw,
      rawRec: withoutRuntimeRecIdentity(raw.rawRec),
    }),
    filtered: hashJson(filtered == null ? null : {
      ...filtered,
      before: withoutRuntimeRecIdentity(filtered.before),
      after: withoutRuntimeRecIdentity(filtered.after),
    }),
    gamma: hashJson(gamma == null ? null : {
      ...gamma,
      filteredRec: withoutRuntimeRecIdentity(gamma.filteredRec),
    }),
    matrix: hashJson({ device: raw?.deviceMatrix, matrices: filtered?.matrices }),
    axis: hashJson(evidence.run?.typeface.axes),
    surface: hashJson({ raw: raw?.surfaceProps, run: run?.surfaceProps }),
    metrics: hashJson(masks[0]?.coreText),
    browser: hashJson(observation.browser.css),
  };
}

export function sfnsValidationChangedEvidenceGroups(
  baseline: SfnsValidationObservation,
  candidate: SfnsValidationObservation,
): string[] {
  const before = sfnsValidationEvidenceGroups(baseline);
  const after = sfnsValidationEvidenceGroups(candidate);
  return Object.keys(before).filter((key) => before[key] !== after[key]).sort();
}

export function sfnsValidationArtifactDigest(
  artifact: Omit<SfnsPinnedChromiumValidationArtifact, "artifactDigest">
    | SfnsPinnedChromiumValidationArtifact,
): string {
  const { artifactDigest: ignored, ...payload } = artifact as SfnsPinnedChromiumValidationArtifact;
  void ignored;
  return hashJson(payload);
}

function validateRec(rec: SfnsValidationRec, label: string, errors: string[]): void {
  const bytes = decodeExactBase64(rec.bytesBase64);
  if (bytes == null) errors.push(`${label}:base64`);
  else {
    if (bytes.length !== rec.byteLength) errors.push(`${label}:byte-length`);
    if (shaBytes(bytes) !== rec.sha256) errors.push(`${label}:sha256`);
  }
  if (!validSha(rec.sha256)) errors.push(`${label}:sha256-shape`);
  if (rec.byteLength !== 56) errors.push(`${label}:pinned-rec-size`);
  if (!Array.isArray(rec.singleMatrix) || rec.singleMatrix.length !== 9
      || rec.singleMatrix.some((value) => !Number.isFinite(value))) errors.push(`${label}:matrix`);
}

function validateEventEnvelope(
  event: SfnsHookEvent,
  observation: SfnsValidationObservation,
  errors: string[],
): void {
  const label = observation.observationId;
  if (event.schemaVersion !== 2 || event.hookAbi !== SFNS_VALIDATION_HOOK_ABI) {
    errors.push(`${label}:hook-abi`);
  }
  if (event.observationId !== observation.observationId
      || event.scenarioId !== observation.scenarioId
      || event.lifecycle !== observation.lifecycle
      || event.controlId !== observation.controlId
      || event.ordinal !== observation.ordinal) errors.push(`${label}:stale-envelope`);
  if (event.source.chromiumRevision !== SFNS_VALIDATION_CHROMIUM_REVISION
      || event.source.skiaRevision !== SFNS_VALIDATION_SKIA_REVISION
      || event.source.sourceFontByteLength !== SFNS_VALIDATION_FONT_BYTE_LENGTH
      || event.source.sourceFontSha256 !== SFNS_VALIDATION_FONT_SHA256
      || event.source.decodedFontByteLength !== SFNS_VALIDATION_DECODED_FONT_BYTE_LENGTH
      || event.source.decodedFontSha256 !== SFNS_VALIDATION_DECODED_FONT_SHA256) {
    errors.push(`${label}:source-revision`);
  }
  if (event.typeface.fontBytes.authority !== "ots-sanitized-sfnt"
      || event.typeface.fontBytes.byteLength !== SFNS_VALIDATION_DECODED_FONT_BYTE_LENGTH
      || event.typeface.fontBytes.sha256 !== SFNS_VALIDATION_DECODED_FONT_SHA256
      || event.typeface.fontBytes.collectionIndex !== 0) {
    errors.push(`${label}:font-identity`);
  }
  if (event.typeface.uniqueId <= 0 || event.processId <= 0) errors.push(`${label}:runtime-identity`);
}

function validateObservation(
  observation: SfnsValidationObservation,
  caseId: SfnsTerminalMaskCaseId,
  request: SfnsTerminalMaskCaseRequest,
  errors: string[],
): void {
  const label = observation.observationId || `${caseId}:unnamed`;
  const manifestCase = sfnsTerminalMaskCase(caseId);
  if (observation.observationId !== expectedObservationId(
    caseId, observation.lifecycle, observation.ordinal,
  )) errors.push(`${label}:arm-qualified-id`);
  if (observation.caseId !== caseId
      || observation.kind !== manifestCase.kind
      || observation.scenarioId !== manifestCase.scenarioId
      || observation.controlId !== manifestCase.controlId) errors.push(`${label}:case-identity`);
  if (!exact(request.run.deviceStart, mapped(request.run.liveDeviceMatrix, request.run.sourceStart))
      || request.run.deviceBaseline !== request.run.deviceStart[1]) {
    errors.push(`${label}:manifest-coordinate-envelope`);
  }
  if (!observation.browser.explicitlyHeadless
      || !observation.browser.launchArgs.includes("--headless=new")) {
    errors.push(`${label}:not-explicitly-headless`);
  }
  if (!validSha(observation.browser.screenshotSha256)) errors.push(`${label}:screenshot-sha256`);
  if (!exact(observation.coordinateSpace, {
    source: "skia-source-space-y-down",
    device: "device-space-y-down",
    coreTextRaw: "coretext-y-up",
    normalized: "device-y-down",
    mask: "glyph-device-space-y-down",
  })) errors.push(`${label}:coordinate-space`);
  if (observation.events.length === 0) errors.push(`${label}:events-empty`);
  const sequences = observation.events.map((event) => event.sequence);
  if (new Set(sequences).size !== sequences.length) errors.push(`${label}:duplicate-sequence`);
  if (sequences.some((sequence, index) => index > 0 && sequence <= sequences[index - 1])) {
    errors.push(`${label}:event-reordered`);
  }
  if (sequences.some((sequence, index) => sequence !== index)) errors.push(`${label}:event-dropped`);
  for (const event of observation.events) validateEventEnvelope(event, observation, errors);

  const evidence = selected(observation);
  if (evidence.shape?.event !== "shape" || evidence.raw?.event !== "raw"
      || evidence.filtered?.event !== "filtered" || evidence.gamma?.event !== "gamma"
      || evidence.run?.event !== "run"
      || evidence.masks.length !== observation.selection.maskSequences.length
      || evidence.masks.some((event) => event.event !== "mask")) errors.push(`${label}:selection`);
  if (evidence.shape == null || evidence.raw == null || evidence.filtered == null
      || evidence.gamma == null || evidence.run == null) return;
  if (observation.events.some((event) => event.processId !== observation.selection.processId)) {
    errors.push(`${label}:cross-process-events`);
  }
  const selectedEvents = [
    evidence.shape, evidence.raw, evidence.filtered, evidence.gamma, evidence.run,
    ...evidence.masks,
  ];
  if (selectedEvents.some((event) => event.processId !== observation.selection.processId
      || event.typeface.uniqueId !== evidence.run!.typeface.uniqueId
      || !exact(event.typeface, evidence.run!.typeface))) {
    errors.push(`${label}:selection-identity`);
  }
  if (!(evidence.shape.sequence < evidence.raw.sequence
      && evidence.raw.sequence < evidence.filtered.sequence
      && evidence.filtered.sequence < evidence.gamma.sequence
      && evidence.gamma.sequence < evidence.run.sequence
      && evidence.masks.every((mask) => mask.sequence > evidence.run!.sequence))) {
    errors.push(`${label}:selection-order`);
  }

  const shape = evidence.shape.payload as SfnsShapePayload;
  const raw = evidence.raw.payload as SfnsRawPayload;
  const filtered = evidence.filtered.payload as SfnsFilteredPayload;
  const gamma = evidence.gamma.payload as SfnsGammaPayload;
  const run = evidence.run.payload as SfnsRunPayload;
  const masks = evidence.masks.map((event) => event.payload as SfnsMaskPayload);
  validateRec(raw.rawRec, `${label}:raw-rec`, errors);
  validateRec(filtered.before, `${label}:filter-before`, errors);
  validateRec(filtered.after, `${label}:filter-after`, errors);
  validateRec(gamma.filteredRec, `${label}:gamma-rec`, errors);
  if (recTypefaceId(raw.rawRec) !== evidence.raw.typeface.uniqueId
      || recTypefaceId(filtered.before) !== evidence.filtered.typeface.uniqueId
      || recTypefaceId(filtered.after) !== evidence.filtered.typeface.uniqueId
      || recTypefaceId(gamma.filteredRec) !== evidence.gamma.typeface.uniqueId) {
    errors.push(`${label}:rec-typeface-identity`);
  }
  if (raw.rawRec.sha256 !== filtered.before.sha256) errors.push(`${label}:raw-filter-link`);
  if (filtered.after.sha256 !== gamma.filteredRec.sha256) errors.push(`${label}:filter-gamma-link`);

  const typeface = evidence.run.typeface;
  const expectedPostscript = request.axes.opsz === 26
    ? ".SFNS-Regular_wdth_opsz1A0000_GRAD_wght2BC0000"
    : ".SFNS-Regular_wdth_opsz110000_GRAD_wght2BC0000";
  if (typeface.family !== ".SF NS" || typeface.postscriptName !== expectedPostscript
      || !exact(typeface.style, { weight: 700, width: 5, slant: 0 })) {
    errors.push(`${label}:typeface-identity`);
  }
  const expectedAxes: Record<string, [number, number, number, boolean, number]> = {
    wdth: [30, 100, 150, false, request.axes.wdth],
    opsz: [17, 28, 96, false, request.axes.opsz],
    GRAD: [400, 400, 1000, true, request.axes.GRAD],
    wght: [1, 400, 1000, false, request.axes.wght],
  };
  const axes = new Map(typeface.axes.map((axis) => [axis.tag, axis]));
  if (axes.size !== 4 || typeface.axes.length !== 4) errors.push(`${label}:axis-count`);
  for (const [tag, expected] of Object.entries(expectedAxes)) {
    const axis = axes.get(tag);
    if (axis == null || !exact(
      [axis.min, axis.default, axis.max, axis.hidden, axis.actual], expected,
    )) errors.push(`${label}:axis:${tag}`);
  }
  if (observation.browser.platformFonts.length !== 1
      || !observation.browser.platformFonts[0].isCustomFont
      || observation.browser.platformFonts[0].glyphCount !== SFNS_VALIDATION_GLYPH_IDS.length
      || observation.browser.platformFonts[0].familyName !== typeface.family
      || observation.browser.platformFonts[0].postScriptName !== typeface.postscriptName) {
    errors.push(`${label}:platform-font`);
  }

  const validationFont = {
    ...request.font,
    edging: request.browserCss.fontSmoothing === "antialiased" ? "aa" : request.font.edging,
    hinting: request.browserCss.fontSmoothing === "antialiased" ? "none" : request.font.hinting,
  };
  if (!exact(raw.font, { size: request.fontSize, ...validationFont })) {
    errors.push(`${label}:font`);
  }
  if (!exact(raw.paint, { color: request.paint.color, style: 0 })) {
    errors.push(`${label}:paint-white`);
  }
  if (!exact(raw.surfaceProps, request.surface)
      || !exact(run.surfaceProps, request.surface)) errors.push(`${label}:surface`);
  if (raw.scalerContextFlags !== request.scalerContextFlags
      || run.scalerContextFlags !== request.scalerContextFlags) {
    errors.push(`${label}:scaler-context-flags`);
  }
  if (!exact(run.font, {
    size: request.fontSize,
    edging: validationFont.edging,
    hinting: validationFont.hinting,
  })) errors.push(`${label}:run-font`);

  const expectedRawMaskFormat = validationFont.edging === "subpixel"
    && request.surface.pixelGeometry !== "unknown" ? "LCD16" : "A8";
  const expectedFilteredMaskFormat = expectedRawMaskFormat === "LCD16"
    && filtered.smoothBehavior === "subpixel" ? "LCD16" : "A8";
  if (raw.rawRec.maskFormat !== expectedRawMaskFormat
      || filtered.before.maskFormat !== expectedRawMaskFormat
      || filtered.after.maskFormat !== expectedFilteredMaskFormat) {
    errors.push(`${label}:lcd-to-a8-route`);
  }
  if (raw.rawRec.textSize !== request.fontSize
      || filtered.before.textSize !== request.fontSize
      || filtered.after.textSize !== request.fontSize) errors.push(`${label}:raw-text-size`);

  const effectiveScale = request.fontSize * request.run.liveDeviceMatrix[0];
  const scaledIdentity = [effectiveScale, 0, 0, 0, effectiveScale, 0, 0, 0, 1];
  const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  if (!filtered.matrices.invertible
      || !exactNumbers(raw.deviceMatrix, request.run.liveDeviceMatrix)
      || !exactNumbers(run.positionMatrix, request.run.liveDeviceMatrix)
      || !exactNumbers(raw.matrices.total, scaledIdentity)
      || !exactNumbers(filtered.matrices.total, scaledIdentity)
      || !exactNumbers(filtered.matrices.scale, [effectiveScale, effectiveScale])
      || !exactNumbers(filtered.matrices.remaining, identity)
      || !exactNumbers(filtered.matrices.remainingWithoutRotation, identity)
      || !exactNumbers(filtered.matrices.remainingRotation, identity)
      || !exactNumbers(raw.rawRec.singleMatrix, scaledIdentity)
      || !exactNumbers(filtered.after.singleMatrix, scaledIdentity)) {
    errors.push(`${label}:matrix-factorization`);
  }

  const tableLength = gamma.tableApplicable ? gamma.tableByteLength : 0;
  validateEncodedBytes(
    gamma.tableBytesBase64, tableLength, gamma.tableSha256, `${label}:gamma-table`, errors,
  );
  for (const channel of ["R", "G", "B"] as const) {
    validateEncodedBytes(
      gamma[`preblend${channel}256Base64`],
      gamma.preblendApplicable ? gamma.preblendByteLength : 0,
      gamma[`preblend${channel}256Sha256`],
      `${label}:preblend-${channel.toLowerCase()}`,
      errors,
    );
  }
  const gammaDump = /device gamma (\d+), contrast (\d+)/.exec(gamma.filteredRec.dump);
  const expectedInputGamma = gammaDump == null ? Number.NaN : Number(gammaDump[1]) / 64;
  const expectedInputContrast = gammaDump == null ? Number.NaN : Number(gammaDump[2]) / 255;
  const expectedGammaApplicable = !(expectedInputGamma === 1 && expectedInputContrast === 0);
  if (gamma.inputContrast !== expectedInputContrast
      || gamma.inputDeviceGamma !== expectedInputGamma
      || gamma.tableApplicable !== expectedGammaApplicable
      || gamma.tableWidth !== 256 || gamma.tableHeight !== 8
      || gamma.tableByteLength !== (expectedGammaApplicable ? 2_048 : 0)
      || gamma.preblendApplicable !== expectedGammaApplicable
      || gamma.preblendByteLength !== (expectedGammaApplicable ? 256 : 0)) {
    errors.push(`${label}:gamma-input-contract`);
  }

  if (shape.coordinateSystem !== "skia-source-space-y-down"
      || shape.glyphs.length !== SFNS_VALIDATION_GLYPH_IDS.length
      || run.glyphs.length !== SFNS_VALIDATION_GLYPH_IDS.length) {
    errors.push(`${label}:glyph-count`);
  }
  let accumulated = [...request.run.sourceStart] as [number, number];
  run.glyphs.forEach((glyph, index) => {
    const shaped = shape.glyphs[index];
    const glyphLabel = `${label}:glyph:${index}`;
    if (shaped == null) return;
    const expectedSource = [
      Math.fround(shaped.accumulatedAdvance[0] + shaped.shapedOffset[0]),
      Math.fround(shaped.accumulatedAdvance[1] + shaped.shapedOffset[1]),
    ];
    const expectedDevice = mapped(request.run.liveDeviceMatrix, expectedSource);
    const expectedRoundedInput = [
      Math.fround(expectedDevice[0] + run.rounding.halfAxisSampleFreq[0]),
      Math.fround(expectedDevice[1] + run.rounding.halfAxisSampleFreq[1]),
    ];
    if (shaped.index !== index || shaped.gid !== SFNS_VALIDATION_GLYPH_IDS[index]
        || shaped.characterIndex !== index || !shaped.horizontal
        || shaped.shapedAdvance.length !== 2 || shaped.shapedAdvance[1] !== 0
        || shaped.shapedOffset.length !== 2 || !shaped.shapedOffset.every(Number.isFinite)
        || !exactNumbers(shaped.accumulatedAdvance, accumulated)
        || glyph.index !== index || glyph.gid !== shaped.gid
        || !exactNumbers(glyph.sourcePosition, expectedSource)
        || !exactNumbers(glyph.deviceOrigin, expectedDevice)
        || !exactNumbers(glyph.mappedWithRounding, expectedRoundedInput)
        || !exactNumbers(glyph.roundedDeviceOrigin, [
          Math.floor(expectedRoundedInput[0]), Math.floor(expectedRoundedInput[1]),
        ])
        || glyph.deviceOrigin[1] !== request.run.deviceBaseline
        || !exactNumbers(run.rounding.halfAxisSampleFreq, [0.125, 0.5])
        || !exactNumbers(run.rounding.ignorePositionFieldMask, [3, 0])) {
      errors.push(`${glyphLabel}:shaping-run-seam`);
    }
    const expectedPhaseX = packedPhase(
      expectedRoundedInput[0], run.rounding.ignorePositionFieldMask[0],
    );
    const expectedPhaseY = packedPhase(
      expectedRoundedInput[1], run.rounding.ignorePositionFieldMask[1],
    );
    const expectedPackedId = ((glyph.gid << 2) | expectedPhaseX | (expectedPhaseY << 18)) >>> 0;
    if (glyph.packedId !== expectedPackedId
        || ((glyph.packedId >>> 2) & 0xffff) !== glyph.gid
        || glyph.phase.x !== expectedPhaseX || glyph.phase.y !== expectedPhaseY
        || glyph.phase.x !== (glyph.packedId & 3)
        || glyph.phase.y !== ((glyph.packedId >>> 18) & 3)) {
      errors.push(`${glyphLabel}:packed-phase`);
    }
    accumulated = [
      Math.fround(accumulated[0] + shaped.shapedAdvance[0]),
      Math.fround(accumulated[1] + shaped.shapedAdvance[1]),
    ];
  });

  const expectedPackedIds = [...new Set(run.glyphs.map((glyph) => glyph.packedId))];
  if (!exactNumbers(masks.map((mask) => mask.glyph.packedId), expectedPackedIds)) {
    errors.push(`${label}:mask-order-or-coverage`);
  }
  for (const [index, mask] of masks.entries()) {
    validateRec(mask.filteredRec, `${label}:mask:${index}:rec`, errors);
    if (recTypefaceId(mask.filteredRec) !== evidence.masks[index].typeface.uniqueId) {
      errors.push(`${label}:mask:${index}:rec-typeface-identity`);
    }
    if (mask.filteredRec.sha256 !== filtered.after.sha256) errors.push(`${label}:mask:${index}:rec-link`);
    validateEncodedBytes(
      mask.glyph.mask.bytes,
      mask.glyph.metrics.imageSize,
      mask.glyph.mask.sha256,
      `${label}:mask:${index}`,
      errors,
    );
    if (mask.glyph.metrics.maskFormat !== expectedFilteredMaskFormat
        || mask.glyph.metrics.imageSize
          !== mask.glyph.metrics.rowBytes * mask.glyph.metrics.height) {
      errors.push(`${label}:mask:${index}:metrics`);
    }
    const runGlyph = run.glyphs.find((glyph) => glyph.packedId === mask.glyph.packedId);
    if (runGlyph == null || runGlyph.gid !== mask.glyph.gid
        || runGlyph.phase.x !== mask.glyph.phase.x
        || runGlyph.phase.y !== mask.glyph.phase.y
        || !exactNumbers(mask.glyph.subpixelOffsetFixed, [
          mask.glyph.phase.x << 14, mask.glyph.phase.y << 14,
        ])) {
      errors.push(`${label}:mask:${index}:run-phase-link`);
    }
    const maskGamma = mask.gamma;
    if (maskGamma.recordDump !== mask.filteredRec.dump
        || !/lum bits [0-9a-f]+, device gamma \d+, contrast \d+/.test(mask.filteredRec.dump)
        || maskGamma.preblendApplicable !== gamma.preblendApplicable
        || maskGamma.preblendR256Sha256 !== gamma.preblendR256Sha256
        || maskGamma.preblendG256Sha256 !== gamma.preblendG256Sha256
        || maskGamma.preblendB256Sha256 !== gamma.preblendB256Sha256) {
      errors.push(`${label}:mask:${index}:gamma-preblend`);
    }
    if (!exact(mask.coreText, observation.coreTextMetrics.raw)) {
      errors.push(`${label}:mask:${index}:coretext-link`);
    }
  }

  const rawMetrics = observation.coreTextMetrics.raw;
  const normalized = observation.coreTextMetrics.normalized;
  const rawMetricKeys = [
    "pointSize", "unitsPerEm", "ascent", "descent", "leading", "capHeight", "xHeight",
  ] as const;
  if (rawMetricKeys.some((key) => !Number.isFinite(rawMetrics[key]))
      || rawMetrics.pointSize !== effectiveScale
      || !Array.isArray(rawMetrics.boundingBox) || rawMetrics.boundingBox.length !== 4
      || rawMetrics.boundingBox.some((value) => !Number.isFinite(value))
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
  if (observation.logicalDigest !== sfnsValidationObservationDigest(observation)) {
    errors.push(`${label}:logical-digest`);
  }
}

const REQUIRED_CONTROL_GROUPS: Record<SfnsValidationControlId, readonly string[]> = {
  "subpixel-phase": ["phase", "mask"],
  "anti-aliasing": ["raw", "filtered", "browser"],
  hinting: ["raw", "filtered", "browser"],
  "device-matrix": ["matrix", "metrics", "mask"],
  "optical-size": ["axis", "shape", "mask"],
  "surface-mask-format": ["surface", "raw", "filtered"],
};

const REQUIRED_BUILD_SOURCE_DIGESTS = [
  "hookHeaderSha256",
  "blinkPlatformBuildGnSha256",
  "shapeResultSha256",
  "shapeResultViewSha256",
  "chromiumSkiaBuildGnSha256",
  "scalerContextSha256",
  "glyphRunPainterSha256",
  "typefaceMacSha256",
  "scalerContextMacSha256",
  "retainedHookHeaderSha256",
  "retainedChromiumPatchSha256",
  "retainedSkiaPatchSha256",
  "retainedBlinkV2PatchSha256",
  "retainedSkiaV2PatchSha256",
  "retainedOverlayReadmeSha256",
  "retainedNodeIsolationProfileSha256",
  "buildDriverSha256",
  "manifestSha256",
  "collectorSha256",
  "schemaSha256",
  "schemaTestSha256",
  "adjudicatorSha256",
  "adjudicatorTestSha256",
] as const;
const REQUIRED_TOOLCHAIN_DIGESTS = ["gnSha256", "ninjaSha256", "clangSha256"] as const;
const REQUIRED_HOST_COMPONENTS = [
  "xcode",
  "macOS",
  "metalToolchainIdentifier",
  "metal",
  "clang",
] as const;

function validateSfnsPinnedChromiumValidationImpl(
  artifact: SfnsPinnedChromiumValidationArtifact,
): string[] {
  const errors: string[] = [];
  if (artifact.schemaVersion !== 2 || artifact.authority !== "validation-test-only-pinned-chromium"
      || artifact.arm !== "validation") errors.push("artifact-envelope");
  if (!exact(artifact.manifest, {
    abi: SFNS_TERMINAL_MASK_MANIFEST_ABI,
    digest: sfnsTerminalMaskManifestDigest(),
  })) errors.push("manifest-identity");
  if (!exact(artifact.collectionContract, {
    browserLaunches: 26,
    processIsolation: "one-explicitly-headless-browser-per-observation",
    inputDerivation: "source-owned-manifest-independent-arm-derivation",
    equality: "exact-bytes-no-tolerance",
    productionRenderingChanges: false,
  })) errors.push("collection-contract");
  if (artifact.build.chromiumRevision !== SFNS_VALIDATION_CHROMIUM_REVISION
      || artifact.build.skiaRevision !== SFNS_VALIDATION_SKIA_REVISION
      || artifact.build.depotToolsRevision !== SFNS_VALIDATION_DEPOT_TOOLS_REVISION) {
    errors.push("build-revisions");
  }
  if (artifact.build.platform !== "darwin" || artifact.build.architecture !== "arm64"
      || artifact.build.gnArgs !== SFNS_VALIDATION_GN_ARGS) {
    errors.push("build-contract");
  }
  if (!artifact.build.binary.path.endsWith("/headless_shell")
      || !validSha(artifact.build.binary.sha256)
      || Object.values(artifact.build.sources).some((digest) => !validSha(digest))
      || Object.values(artifact.build.toolchain).some((digest) => !validSha(digest))) {
    errors.push("build-digests");
  }
  if (!exactKeys(artifact.build.sources, REQUIRED_BUILD_SOURCE_DIGESTS)
      || !exactKeys(artifact.build.toolchain, REQUIRED_TOOLCHAIN_DIGESTS)) {
    errors.push("build-input-coverage");
  }
  if (!exactKeys(artifact.build.hostComponents, REQUIRED_HOST_COMPONENTS)
      || Object.values(artifact.build.hostComponents).some((value) => value.trim() === "")) {
    errors.push("host-components");
  }
  if (!exact(artifact.corpus, {
    text: SFNS_TERMINAL_MASK_MANIFEST.corpus.text,
    fontPath: SFNS_TERMINAL_MASK_MANIFEST.corpus.fontPath,
    sourceFontByteLength: SFNS_VALIDATION_FONT_BYTE_LENGTH,
    sourceFontSha256: SFNS_VALIDATION_FONT_SHA256,
    decodedFontByteLength: SFNS_VALIDATION_DECODED_FONT_BYTE_LENGTH,
    decodedFontSha256: SFNS_VALIDATION_DECODED_FONT_SHA256,
    collectionIndex: SFNS_TERMINAL_MASK_MANIFEST.corpus.collectionIndex,
    glyphIds: [...SFNS_VALIDATION_GLYPH_IDS],
  })) errors.push("corpus");
  if (artifact.scenarios.length !== SFNS_VALIDATION_SCENARIOS.length
      || new Set(artifact.scenarios.map((scenario) => scenario.id)).size
        !== SFNS_VALIDATION_SCENARIOS.length) errors.push("scenario-set");
  const allObservationIds = new Set<string>();
  for (const id of SFNS_VALIDATION_SCENARIOS) {
    const scenario = artifact.scenarios.find((candidate) => candidate.id === id);
    if (scenario == null) { errors.push(`${id}:missing`); continue; }
    const request = sfnsTerminalMaskCase(id).request;
    if (!exact(scenario.request, request)) errors.push(`${id}:manifest-request`);
    if (scenario.observations.length !== 4) { errors.push(`${id}:observation-count`); continue; }
    const expectedLifecycle = ["cold", "cold", "warm", "warm"];
    const expectedOrdinals = [1, 2, 1, 2];
    scenario.observations.forEach((observation, index) => {
      if (observation.lifecycle !== expectedLifecycle[index]
          || observation.ordinal !== expectedOrdinals[index] || observation.controlId !== "") {
        errors.push(`${id}:lifecycle-order`);
      }
      if (allObservationIds.has(observation.observationId)) errors.push(`${id}:duplicate-observation-id`);
      allObservationIds.add(observation.observationId);
      validateObservation(observation, id, request, errors);
    });
    const digests = scenario.observations.map(sfnsValidationObservationDigest);
    if (new Set(digests).size !== 1 || scenario.observationLogicalDigest !== digests[0]) {
      errors.push(`${id}:cold-warm-instability`);
    }
  }
  if (artifact.controls.length !== SFNS_VALIDATION_CONTROLS.length
      || new Set(artifact.controls.map((control) => control.id)).size
        !== SFNS_VALIDATION_CONTROLS.length) errors.push("control-set");
  const baseline = artifact.scenarios.find((scenario) => scenario.id === "zoom-2")?.observations[0];
  for (const id of SFNS_VALIDATION_CONTROLS) {
    const control = artifact.controls.find((candidate) => candidate.id === id);
    if (control == null || baseline == null) { errors.push(`${id}:missing`); continue; }
    const caseId = `control-${id}` as const;
    const request = sfnsTerminalMaskCase(caseId).request;
    const observation = control.observation;
    if (observation.lifecycle !== "control" || observation.controlId !== id
        || observation.ordinal !== 1 || control.baselineScenarioId !== "zoom-2"
        || control.caseId !== caseId || !exact(control.request, request)) {
      errors.push(`${id}:envelope`);
    }
    if (allObservationIds.has(observation.observationId)) errors.push(`${id}:duplicate-observation-id`);
    allObservationIds.add(observation.observationId);
    validateObservation(observation, caseId, request, errors);
    const actualGroups = sfnsValidationChangedEvidenceGroups(baseline, observation);
    if (hashJson(actualGroups) !== hashJson(control.changedEvidenceGroups)) {
      errors.push(`${id}:changed-groups`);
    }
    for (const group of REQUIRED_CONTROL_GROUPS[id]) {
      if (!actualGroups.includes(group)) errors.push(`${id}:inactive:${group}`);
    }
  }
  if (allObservationIds.size !== 26) errors.push("observation-identity-count");
  if (artifact.artifactDigest !== sfnsValidationArtifactDigest(artifact)) {
    errors.push("artifact-digest");
  }
  return [...new Set(errors)];
}

export function validateSfnsPinnedChromiumValidation(
  artifact: SfnsPinnedChromiumValidationArtifact,
): string[] {
  try {
    return validateSfnsPinnedChromiumValidationImpl(artifact);
  } catch (error) {
    return [`malformed-artifact:${error instanceof Error ? error.message : String(error)}`];
  }
}
