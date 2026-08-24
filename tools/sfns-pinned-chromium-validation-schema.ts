/**
 * Fail-closed schema for DM-2575's test-only pinned-Chromium SFNS trace.
 *
 * The artifact contains observed scaler records and post-conversion mask bytes.
 * It never changes production rendering and it never applies a tolerance.
 */
import { createHash } from "node:crypto";

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
export const SFNS_VALIDATION_HOOK_ABI = "domotion-sfns-pinned-chromium-hook-v1";
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
  "",
].join("\n");
export const SFNS_VALIDATION_GLYPH_IDS = [969, 815, 815, 795, 1310, 1377] as const;

export const SFNS_VALIDATION_SCENARIOS = [
  "zoom-2",
  "transform-scale-2",
  "zoom-2-transform-half",
  "optical-sizing-none",
  "opsz-26-mutation",
] as const;
export type SfnsValidationScenarioId = typeof SFNS_VALIDATION_SCENARIOS[number];

export const SFNS_VALIDATION_CONTROLS = [
  "subpixel-phase",
  "anti-aliasing",
  "hinting",
  "device-matrix",
  "optical-size",
  "surface-mask-format",
] as const;
export type SfnsValidationControlId = typeof SFNS_VALIDATION_CONTROLS[number];

export const SFNS_VALIDATION_SCENARIO_CONTRACT: Record<SfnsValidationScenarioId, {
  opsz: number;
  textSize: number;
  scaler: number;
  baseline: number;
  origins: readonly number[];
}> = {
  "zoom-2": {
    opsz: 17, textSize: 26, scaler: 26, baseline: 43,
    origins: [37.25, 51.6591796875, 67.76953125, 83.8798828125, 108.115234375, 124.8349609375],
  },
  "transform-scale-2": {
    opsz: 17, textSize: 13, scaler: 26, baseline: 26,
    origins: [0, 14.4091796875, 30.51953125, 46.6298828125, 70.865234375, 87.5849609375],
  },
  "zoom-2-transform-half": {
    opsz: 17, textSize: 26, scaler: 13, baseline: 12.5,
    origins: [0, 7.20458984375, 15.259765625, 23.31494140625, 35.4326171875, 43.79248046875],
  },
  "optical-sizing-none": {
    opsz: 17, textSize: 26, scaler: 26, baseline: 43,
    origins: [37.25, 51.6591796875, 67.76953125, 83.8798828125, 108.115234375, 124.8349609375],
  },
  "opsz-26-mutation": {
    opsz: 26, textSize: 26, scaler: 26, baseline: 43,
    origins: [37.25, 50.268417358398438, 65.270767211914062, 80.273117065429688, 102.881103515625, 118.6544189453125],
  },
};

export const SFNS_VALIDATION_CONTROL_GEOMETRY: Record<SfnsValidationControlId, {
  baseline: number;
  origins: readonly number[];
}> = {
  "subpixel-phase": {
    baseline: 43,
    origins: [37.5, 51.9091796875, 68.01953125, 84.1298828125, 108.365234375, 125.0849609375],
  },
  "anti-aliasing": {
    baseline: 43,
    origins: [37.25, 51.6591796875, 67.76953125, 83.8798828125, 108.115234375, 124.8349609375],
  },
  hinting: {
    baseline: 43,
    origins: [37.25, 51.6591796875, 67.76953125, 83.8798828125, 108.115234375, 124.8349609375],
  },
  "device-matrix": {
    baseline: 31.25,
    origins: [0, 18.011474609375, 38.1494140625, 58.287353515625, 88.58154296875, 109.481201171875],
  },
  "optical-size": {
    baseline: 43,
    origins: [37.25, 50.268417358398438, 65.270767211914062, 80.273117065429688, 102.881103515625, 118.6544189453125],
  },
  "surface-mask-format": {
    baseline: 25,
    origins: [0.25, 14.6591796875, 30.76953125, 46.8798828125, 71.115234375, 87.8349609375],
  },
};

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

export type SfnsHookEventName = "raw" | "filtered" | "run" | "mask";
export type SfnsHookPayload =
  SfnsRawPayload | SfnsFilteredPayload | SfnsRunPayload | SfnsMaskPayload;

export interface SfnsHookEvent {
  schemaVersion: 1;
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

export interface SfnsValidationObservation {
  observationId: string;
  scenarioId: SfnsValidationScenarioId;
  lifecycle: "cold" | "warm" | "control";
  controlId: string;
  ordinal: number;
  browser: SfnsValidationBrowserFacts;
  events: SfnsHookEvent[];
  selection: {
    processId: number;
    rawSequence: number;
    filteredSequence: number;
    runSequence: number;
    maskSequences: number[];
  };
  logicalDigest: string;
}

export interface SfnsPinnedChromiumValidationArtifact {
  schemaVersion: 1;
  authority: "validation-test-only-pinned-chromium";
  arm: "validation";
  collectionContract: {
    browserLaunches: 26;
    processIsolation: "one-explicitly-headless-browser-per-observation";
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
  corpus: { fontPath: string; fontByteLength: number; fontSha256: string; glyphIds: number[] };
  scenarios: Array<{
    id: SfnsValidationScenarioId;
    observationLogicalDigest: string;
    observations: SfnsValidationObservation[];
  }>;
  controls: Array<{
    id: SfnsValidationControlId;
    baselineScenarioId: "zoom-2";
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
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
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
    case "mask": {
      const payload = event.payload as SfnsMaskPayload;
      return { ...payload, filteredRec: withoutRuntimeRecIdentity(payload.filteredRec) };
    }
    case "run":
      return event.payload;
  }
}

function eventAt(observation: SfnsValidationObservation, sequence: number): SfnsHookEvent | undefined {
  return observation.events.find((event) => event.sequence === sequence);
}

function selected(observation: SfnsValidationObservation): {
  raw?: SfnsHookEvent;
  filtered?: SfnsHookEvent;
  run?: SfnsHookEvent;
  masks: SfnsHookEvent[];
} {
  return {
    raw: eventAt(observation, observation.selection.rawSequence),
    filtered: eventAt(observation, observation.selection.filteredSequence),
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
    scenarioId: observation.scenarioId,
    browser: observation.browser,
    raw: strip(evidence.raw),
    filtered: strip(evidence.filtered),
    run: strip(evidence.run),
    masks: evidence.masks.map(strip),
  });
}

export function sfnsValidationEvidenceGroups(
  observation: SfnsValidationObservation,
): Record<string, string> {
  const evidence = selected(observation);
  const raw = evidence.raw?.payload as SfnsRawPayload | undefined;
  const filtered = evidence.filtered?.payload as SfnsFilteredPayload | undefined;
  const run = evidence.run?.payload as SfnsRunPayload | undefined;
  const masks = evidence.masks.map((event) => event.payload as SfnsMaskPayload);
  return {
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
    matrix: hashJson({ device: raw?.deviceMatrix, matrices: filtered?.matrices }),
    axis: hashJson(evidence.run?.typeface.axes),
    surface: hashJson({ raw: raw?.surfaceProps, run: run?.surfaceProps }),
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
  if (event.schemaVersion !== 1 || event.hookAbi !== SFNS_VALIDATION_HOOK_ABI) {
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
      || event.typeface.fontBytes.sha256 !== SFNS_VALIDATION_DECODED_FONT_SHA256) {
    errors.push(`${label}:font-identity`);
  }
  if (event.typeface.uniqueId <= 0 || event.processId <= 0) errors.push(`${label}:runtime-identity`);
}

function validateObservation(
  observation: SfnsValidationObservation,
  scenarioId: SfnsValidationScenarioId,
  errors: string[],
): void {
  const label = observation.observationId || `${scenarioId}:unnamed`;
  if (observation.scenarioId !== scenarioId) errors.push(`${label}:scenario-id`);
  if (!observation.browser.explicitlyHeadless
      || !observation.browser.launchArgs.some((arg) => arg.startsWith("--headless"))) {
    errors.push(`${label}:not-explicitly-headless`);
  }
  if (!validSha(observation.browser.screenshotSha256)) errors.push(`${label}:screenshot-sha256`);
  if (observation.browser.platformFonts.length !== 1
      || !observation.browser.platformFonts[0].isCustomFont
      || observation.browser.platformFonts[0].glyphCount !== SFNS_VALIDATION_GLYPH_IDS.length
      || !observation.browser.platformFonts[0].postScriptName.startsWith(".SFNS-")) {
    errors.push(`${label}:platform-font`);
  }
  if (observation.events.length === 0) errors.push(`${label}:events-empty`);
  const sequences = observation.events.map((event) => event.sequence);
  if (new Set(sequences).size !== sequences.length) errors.push(`${label}:duplicate-sequence`);
  if (sequences.some((sequence, index) => index > 0 && sequence <= sequences[index - 1])) {
    errors.push(`${label}:event-reordered`);
  }
  if (sequences.some((sequence, index) => sequence !== index)) errors.push(`${label}:event-dropped`);
  for (const event of observation.events) validateEventEnvelope(event, observation, errors);

  const evidence = selected(observation);
  if (evidence.raw?.event !== "raw" || evidence.filtered?.event !== "filtered"
      || evidence.run?.event !== "run" || evidence.masks.length !== observation.selection.maskSequences.length
      || evidence.masks.some((event) => event.event !== "mask")) errors.push(`${label}:selection`);
  if (evidence.raw == null || evidence.filtered == null || evidence.run == null) return;
  if (observation.events.some((event) => event.processId !== observation.selection.processId)) {
    errors.push(`${label}:cross-process-events`);
  }
  const selectedEvents = [evidence.raw, evidence.filtered, evidence.run, ...evidence.masks];
  if (selectedEvents.some((event) => event.processId !== observation.selection.processId
      || event.typeface.uniqueId !== evidence.run!.typeface.uniqueId)) {
    errors.push(`${label}:selection-identity`);
  }
  if (!(evidence.raw.sequence < evidence.filtered.sequence
      && evidence.filtered.sequence < evidence.run.sequence
      && evidence.masks.every((mask) => mask.sequence > evidence.run!.sequence))) {
    errors.push(`${label}:selection-order`);
  }

  const raw = evidence.raw.payload as SfnsRawPayload;
  const filtered = evidence.filtered.payload as SfnsFilteredPayload;
  const run = evidence.run.payload as SfnsRunPayload;
  const masks = evidence.masks.map((event) => event.payload as SfnsMaskPayload);
  validateRec(raw.rawRec, `${label}:raw-rec`, errors);
  validateRec(filtered.before, `${label}:filter-before`, errors);
  validateRec(filtered.after, `${label}:filter-after`, errors);
  if (recTypefaceId(raw.rawRec) !== evidence.raw.typeface.uniqueId
      || recTypefaceId(filtered.before) !== evidence.filtered.typeface.uniqueId
      || recTypefaceId(filtered.after) !== evidence.filtered.typeface.uniqueId) {
    errors.push(`${label}:rec-typeface-identity`);
  }
  if (raw.rawRec.sha256 !== filtered.before.sha256) errors.push(`${label}:raw-filter-link`);
  const expectedRawMaskFormat = observation.controlId === "anti-aliasing"
    || observation.controlId === "surface-mask-format" ? "A8" : "LCD16";
  if (raw.rawRec.maskFormat !== expectedRawMaskFormat
      || filtered.before.maskFormat !== expectedRawMaskFormat
      || filtered.after.maskFormat !== "A8") {
    errors.push(`${label}:lcd-to-a8-route`);
  }
  const contract = SFNS_VALIDATION_SCENARIO_CONTRACT[scenarioId];
  const expectedTextSize = observation.controlId === "device-matrix"
    ? SFNS_VALIDATION_SCENARIO_CONTRACT["zoom-2"].textSize
    : contract.textSize;
  if (raw.rawRec.textSize !== expectedTextSize
      || filtered.before.textSize !== expectedTextSize
      || filtered.after.textSize !== expectedTextSize
      || (raw.font.size as number) !== expectedTextSize
      || (run.font.size as number) !== expectedTextSize) {
    errors.push(`${label}:raw-text-size`);
  }
  if (run.glyphs.length !== SFNS_VALIDATION_GLYPH_IDS.length
      || run.glyphs.some((glyph, index) => glyph.index !== index
        || glyph.gid !== SFNS_VALIDATION_GLYPH_IDS[index])) errors.push(`${label}:glyph-order`);
  const expectedGeometry = observation.controlId === ""
    ? SFNS_VALIDATION_SCENARIO_CONTRACT[scenarioId]
    : SFNS_VALIDATION_CONTROL_GEOMETRY[observation.controlId as SfnsValidationControlId];
  if (!exactNumbers(
    run.glyphs.map((glyph) => glyph.deviceOrigin[0]), expectedGeometry.origins,
  )) errors.push(`${label}:device-origins`);
  if (!exactNumbers(
    run.glyphs.map((glyph) => glyph.deviceOrigin[1]),
    Array(run.glyphs.length).fill(expectedGeometry.baseline),
  )) errors.push(`${label}:baseline`);
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
    const bytes = decodeExactBase64(mask.glyph.mask.bytes);
    if (bytes == null) errors.push(`${label}:mask:${index}:base64`);
    else {
      if (bytes.length !== mask.glyph.metrics.imageSize) errors.push(`${label}:mask:${index}:size`);
      if (shaBytes(bytes) !== mask.glyph.mask.sha256) errors.push(`${label}:mask:${index}:sha256`);
    }
    if (mask.glyph.metrics.maskFormat !== "A8") errors.push(`${label}:mask:${index}:format`);
    const runGlyph = run.glyphs.find((glyph) => glyph.packedId === mask.glyph.packedId);
    if (runGlyph == null || runGlyph.gid !== mask.glyph.gid
        || runGlyph.phase.x !== mask.glyph.phase.x
        || runGlyph.phase.y !== mask.glyph.phase.y) {
      errors.push(`${label}:mask:${index}:run-phase-link`);
    }
    const gamma = mask.gamma;
    const gammaDigests = [
      gamma.preblendR256Sha256,
      gamma.preblendG256Sha256,
      gamma.preblendB256Sha256,
    ];
    if (gamma.recordDump !== mask.filteredRec.dump
        || !/lum bits [0-9a-f]+, device gamma \d+, contrast \d+/.test(mask.filteredRec.dump)
        || typeof gamma.preblendApplicable !== "boolean"
        || gammaDigests.some((digest) => !validSha(digest))) {
      errors.push(`${label}:mask:${index}:gamma-preblend`);
    }
    const coreText = mask.coreText;
    if (coreText.pointSize !== (observation.controlId === "device-matrix" ? 32.5 : contract.scaler)
        || typeof coreText.unitsPerEm !== "number"
        || typeof coreText.ascent !== "number"
        || typeof coreText.descent !== "number"
        || !Array.isArray(coreText.boundingBox)) {
      errors.push(`${label}:mask:${index}:coretext-metrics`);
    }
  }
  const expectedScaler = observation.controlId === "device-matrix" ? 32.5 : contract.scaler;
  if (!exactNumbers(filtered.matrices.scale, [expectedScaler, expectedScaler])) {
    errors.push(`${label}:factored-scale`);
  }
  if (!filtered.matrices.invertible) errors.push(`${label}:matrix-invertible`);
  const axes = new Map(evidence.run.typeface.axes.map((axis) => [axis.tag, axis.actual]));
  const expectedAxes: Record<string, number> = {
    wdth: 100,
    opsz: observation.controlId === "optical-size" ? 26 : contract.opsz,
    GRAD: 400,
    wght: 700,
  };
  for (const [tag, expected] of Object.entries(expectedAxes)) {
    if (axes.get(tag) !== expected) errors.push(`${label}:axis:${tag}`);
  }
  if (observation.logicalDigest !== sfnsValidationObservationDigest(observation)) {
    errors.push(`${label}:logical-digest`);
  }
}

const REQUIRED_CONTROL_GROUPS: Record<SfnsValidationControlId, readonly string[]> = {
  "subpixel-phase": ["phase", "mask"],
  "anti-aliasing": ["raw", "filtered", "browser"],
  hinting: ["raw", "filtered", "browser"],
  "device-matrix": ["matrix", "mask"],
  "optical-size": ["axis", "mask"],
  "surface-mask-format": ["surface", "raw", "filtered"],
};

const REQUIRED_BUILD_SOURCE_DIGESTS = [
  "hookHeaderSha256",
  "chromiumSkiaBuildGnSha256",
  "scalerContextSha256",
  "glyphRunPainterSha256",
  "typefaceMacSha256",
  "scalerContextMacSha256",
  "retainedHookHeaderSha256",
  "retainedChromiumPatchSha256",
  "retainedSkiaPatchSha256",
  "retainedOverlayReadmeSha256",
  "retainedNodeIsolationProfileSha256",
  "buildDriverSha256",
  "collectorSha256",
  "schemaSha256",
  "schemaTestSha256",
] as const;
const REQUIRED_TOOLCHAIN_DIGESTS = ["gnSha256", "ninjaSha256", "clangSha256"] as const;
const REQUIRED_HOST_COMPONENTS = [
  "xcode",
  "macOS",
  "metalToolchainIdentifier",
  "metal",
  "clang",
] as const;

export function validateSfnsPinnedChromiumValidation(
  artifact: SfnsPinnedChromiumValidationArtifact,
): string[] {
  const errors: string[] = [];
  if (artifact.schemaVersion !== 1 || artifact.authority !== "validation-test-only-pinned-chromium"
      || artifact.arm !== "validation") errors.push("artifact-envelope");
  if (artifact.collectionContract.browserLaunches !== 26
      || artifact.collectionContract.processIsolation
        !== "one-explicitly-headless-browser-per-observation"
      || artifact.collectionContract.equality !== "exact-bytes-no-tolerance"
      || artifact.collectionContract.productionRenderingChanges !== false) {
    errors.push("collection-contract");
  }
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
  if (artifact.corpus.fontByteLength !== SFNS_VALIDATION_FONT_BYTE_LENGTH
      || artifact.corpus.fontSha256 !== SFNS_VALIDATION_FONT_SHA256
      || !exactNumbers(artifact.corpus.glyphIds, SFNS_VALIDATION_GLYPH_IDS)) errors.push("corpus");
  if (artifact.scenarios.length !== SFNS_VALIDATION_SCENARIOS.length
      || new Set(artifact.scenarios.map((scenario) => scenario.id)).size
        !== SFNS_VALIDATION_SCENARIOS.length) errors.push("scenario-set");
  const allObservationIds = new Set<string>();
  for (const id of SFNS_VALIDATION_SCENARIOS) {
    const scenario = artifact.scenarios.find((candidate) => candidate.id === id);
    if (scenario == null) { errors.push(`${id}:missing`); continue; }
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
      validateObservation(observation, id, errors);
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
    const observation = control.observation;
    if (observation.lifecycle !== "control" || observation.controlId !== id
        || observation.ordinal !== 1 || control.baselineScenarioId !== "zoom-2") {
      errors.push(`${id}:envelope`);
    }
    if (allObservationIds.has(observation.observationId)) errors.push(`${id}:duplicate-observation-id`);
    allObservationIds.add(observation.observationId);
    validateObservation(observation, observation.scenarioId, errors);
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
  return errors;
}
