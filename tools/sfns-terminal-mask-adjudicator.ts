/**
 * Exact cross-arm adjudicator for the macOS SFNS terminal-mask evidence.
 *
 * The proposal and validation collectors intentionally remain independent.
 * This file does not rasterize, launch a browser, alter production rendering,
 * or define a pixel tolerance. It authenticates each input with its own
 * fail-closed schema, then compares the source-owned rendering facts and every
 * post-conversion mask byte.
 *
 * Pinned Skia source ownership (62efacd37737505732dbe3d8daa62abd679626a1):
 * - SkScalerContext.cpp:1087-1221 constructs the raw record from the font,
 *   paint, surface properties, scaler flags, and live device matrix.
 * - SkTypeface_mac_ct.cpp:887-986 filters hinting/mask/luminance/preblend.
 * - SkScalerContext_mac_ct.cpp:464-519 produces the final A8/LCD16 bytes.
 *
 * SkScalerContextRec's first four bytes are the process-local SkTypefaceID.
 * The per-arm schemas authenticate that ID against the selected typeface. Only
 * those four identity-plumbing bytes are zeroed for cross-process comparison;
 * every other record byte and every mask byte remains exact.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  SFNS_CONTROL_IDS,
  SFNS_PINNED_SCENARIOS,
  sfnsPinnedArtifactDigest,
  validateSfnsPinnedSkiaProposal,
  type SfnsMaskGlyph,
  type SfnsPinnedObservation,
  type SfnsPinnedSkiaProposalArtifact,
  type SfnsRecEvidence,
} from "./sfns-pinned-skia-mask-schema.js";
import {
  SFNS_VALIDATION_CONTROLS,
  SFNS_VALIDATION_SCENARIOS,
  sfnsValidationArtifactDigest,
  validateSfnsPinnedChromiumValidation,
  type SfnsFilteredPayload,
  type SfnsHookEvent,
  type SfnsMaskPayload,
  type SfnsPinnedChromiumValidationArtifact,
  type SfnsRawPayload,
  type SfnsRunGlyph,
  type SfnsRunPayload,
  type SfnsValidationObservation,
  type SfnsValidationRec,
} from "./sfns-pinned-chromium-validation-schema.js";

export const SFNS_TERMINAL_ADJUDICATOR_ABI =
  "domotion-sfns-terminal-mask-adjudicator-v1";

interface InputFileIdentity {
  path: string;
  sha256: string;
}

interface ExactMismatch {
  caseId: string;
  observationPair: string;
  group: string;
  proposalDigest: string;
  validationDigest: string;
}

interface ObservationPairResult {
  caseId: string;
  proposalObservationId: string;
  validationObservationId: string;
  mismatchGroups: string[];
}

export interface SfnsTerminalMaskAdjudicationReport {
  schemaVersion: 1;
  authority: "exact-cross-arm-adjudication";
  adjudicatorAbi: string;
  contract: {
    equality: "exact-logical-fields-and-bytes-no-tolerance";
    recNormalization: "zero-only-process-local-four-byte-typeface-id";
    productionRenderingChanges: false;
    browserLaunches: 0;
  };
  inputs: {
    proposal: InputFileIdentity & {
      authority: string;
      artifactDigest: string;
      recomputedArtifactDigest: string;
      buildIdentity: string;
      binarySha256: string;
    };
    validation: InputFileIdentity & {
      authority: string;
      artifactDigest: string;
      recomputedArtifactDigest: string;
      buildIdentity: string;
      binarySha256: string;
    };
  };
  independence: {
    distinctAuthorities: boolean;
    distinctBuildIdentities: boolean;
    distinctBinaryDigests: boolean;
    distinctObservationIds: boolean;
  };
  cancellationDecision: {
    required: "13px-scaler-not-26px-later-resample";
    requiredScale: [13, 13];
    proposalScales: number[][];
    validationScales: number[][];
    exact: boolean;
  };
  observationPairs: ObservationPairResult[];
  inputIntegrityErrors: string[];
  mismatches: ExactMismatch[];
  ready: boolean;
  reportDigest: string;
}

interface ValidationEvidence {
  raw: SfnsHookEvent;
  filtered: SfnsHookEvent;
  run: SfnsHookEvent;
  masks: SfnsHookEvent[];
}

interface ComparableObservation {
  source: unknown;
  typeface: unknown;
  font: unknown;
  paint: unknown;
  surfaceProps: unknown;
  scalerContextFlags: unknown;
  rawRec: unknown;
  filteredRec: unknown;
  matrices: unknown;
  smoothBehavior: unknown;
  gamma: unknown;
  fontMetrics: unknown;
  glyphs: Array<{
    identity: unknown;
    advance: unknown;
    offset: unknown;
    placement: unknown;
    phase: unknown;
    metrics: unknown;
    mask: unknown;
  }>;
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

function value(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : null;
}

function normalizeFont(record: Record<string, unknown>): unknown {
  return {
    size: value(record, "size"),
    scaleX: value(record, "scaleX"),
    skewX: value(record, "skewX"),
    subpixel: value(record, "subpixel"),
    linearMetrics: value(record, "linearMetrics"),
    embeddedBitmaps: value(record, "embeddedBitmaps"),
    edging: value(record, "edging"),
    hinting: value(record, "hinting"),
  };
}

function normalizePaint(record: Record<string, unknown>): unknown {
  return { color: value(record, "color"), style: value(record, "style") };
}

function normalizeSurface(record: Record<string, unknown>): unknown {
  return {
    flags: value(record, "flags"),
    pixelGeometry: value(record, "pixelGeometry"),
    textContrast: value(record, "textContrast"),
    textGamma: value(record, "textGamma"),
  };
}

function decodeBase64(valueToDecode: string): Buffer | null {
  try {
    const bytes = Buffer.from(valueToDecode, "base64");
    return bytes.toString("base64") === valueToDecode ? bytes : null;
  } catch {
    return null;
  }
}

function recordWithoutRuntimeTypeface(
  rec: SfnsRecEvidence | SfnsValidationRec,
): unknown {
  const bytes = decodeBase64(rec.bytesBase64);
  if (bytes == null || bytes.length < 4) {
    return { invalidBase64: true, byteLength: rec.byteLength };
  }
  bytes.fill(0, 0, 4);
  return {
    byteLength: rec.byteLength,
    bytesBase64: bytes.toString("base64"),
    sha256: shaBytes(bytes),
    dump: rec.dump,
    textSize: rec.textSize,
    maskFormat: rec.maskFormat,
    flags: rec.flags,
    hinting: rec.hinting,
    luminanceColor: rec.luminanceColor,
    singleMatrix: rec.singleMatrix,
  };
}

function normalizeProposalAxes(observation: SfnsPinnedObservation): unknown {
  return observation.typeface.axes.map((axis) => ({
    tag: axis.tag,
    min: axis.min,
    default: axis.default,
    max: axis.max,
    hidden: axis.hidden,
    actual: axis.actual,
  }));
}

function normalizeValidationAxes(event: SfnsHookEvent): unknown {
  return event.typeface.axes.map((axis) => ({
    tag: axis.tag,
    min: axis.min,
    default: axis.default,
    max: axis.max,
    hidden: axis.hidden,
    actual: axis.actual,
  }));
}

function selectedValidationEvidence(observation: SfnsValidationObservation): ValidationEvidence {
  const event = (sequence: number): SfnsHookEvent => {
    const match = observation.events.find((candidate) => candidate.sequence === sequence);
    if (match == null) throw new Error(`missing selected event ${sequence}`);
    return match;
  };
  return {
    raw: event(observation.selection.rawSequence),
    filtered: event(observation.selection.filteredSequence),
    run: event(observation.selection.runSequence),
    masks: observation.selection.maskSequences.map(event),
  };
}

function normalizedProposalMetrics(observation: SfnsPinnedObservation): unknown {
  return observation.fontMetrics;
}

function normalizedValidationMetrics(mask: SfnsMaskPayload | undefined): unknown {
  if (mask == null) return null;
  const metrics = mask.coreText;
  const box = value(metrics, "boundingBox");
  if (!Array.isArray(box) || box.length !== 4 || box.some((entry) => !Number.isFinite(entry))) {
    return { invalidBoundingBox: box };
  }
  const [x, y, width, height] = box as number[];
  const ascent = value(metrics, "ascent");
  return {
    top: -(y + height),
    ascent: typeof ascent === "number" ? -ascent : ascent,
    descent: value(metrics, "descent"),
    bottom: -y,
    leading: value(metrics, "leading"),
    avgCharWidth: width,
    maxCharWidth: width,
    xMin: x,
    xMax: x + width,
    xHeight: value(metrics, "xHeight"),
    capHeight: value(metrics, "capHeight"),
  };
}

function proposalGlyph(glyph: SfnsMaskGlyph): ComparableObservation["glyphs"][number] {
  return {
    identity: { index: glyph.index, gid: glyph.gid },
    advance: glyph.advance,
    offset: glyph.offset,
    placement: { baseline: glyph.baseline, deviceOrigin: glyph.deviceOrigin },
    phase: {
      packedId: glyph.packedId,
      phase: glyph.phase,
      rounding: glyph.rounding,
      subpixelOffsetFixed: [glyph.phase.x * 16_384, glyph.phase.y * 16_384],
    },
    metrics: glyph.metrics,
    mask: { encoding: glyph.mask.encoding, bytes: glyph.mask.bytes, sha256: glyph.mask.sha256 },
  };
}

function validationGlyph(
  glyph: SfnsRunGlyph,
  rounding: SfnsRunPayload["rounding"],
  masks: Map<number, SfnsMaskPayload>,
): ComparableObservation["glyphs"][number] {
  const mask = masks.get(glyph.packedId);
  return {
    identity: { index: glyph.index, gid: glyph.gid },
    advance: mask?.glyph.advance ?? null,
    // The validation v1 artifact retains the strike subpixel fixed offset,
    // not the shaped glyph offset required by the cross-arm contract. Do not
    // infer the absent logical fact from neighboring positions.
    offset: null,
    placement: { baseline: glyph.deviceOrigin[1] ?? null, deviceOrigin: glyph.deviceOrigin[0] ?? null },
    phase: {
      packedId: glyph.packedId,
      phase: glyph.phase,
      rounding,
      subpixelOffsetFixed: mask?.glyph.subpixelOffsetFixed ?? null,
    },
    metrics: mask?.glyph.metrics ?? null,
    mask: mask == null ? null : {
      encoding: mask.glyph.mask.encoding,
      bytes: mask.glyph.mask.bytes,
      sha256: mask.glyph.mask.sha256,
    },
  };
}

function proposalComparable(
  observation: SfnsPinnedObservation,
): ComparableObservation {
  return {
    source: observation.source,
    typeface: {
      family: observation.typeface.family,
      postscriptName: observation.typeface.postscriptName,
      style: observation.typeface.style,
      axes: normalizeProposalAxes(observation),
    },
    font: observation.font,
    paint: observation.paint,
    surfaceProps: observation.surfaceProps,
    scalerContextFlags: 3,
    rawRec: recordWithoutRuntimeTypeface(observation.rawRec),
    filteredRec: recordWithoutRuntimeTypeface(observation.filteredRec),
    matrices: {
      total: observation.matrices.total,
      scale: observation.matrices.scale,
      remaining: observation.matrices.remaining,
      remainingWithoutRotation: observation.matrices.remainingWithoutRotation,
      remainingRotation: observation.matrices.remainingRotation,
      invertible: observation.matrices.invertible,
    },
    smoothBehavior: observation.smoothBehavior,
    gamma: observation.gamma,
    fontMetrics: normalizedProposalMetrics(observation),
    glyphs: observation.glyphs.map(proposalGlyph),
  };
}

function validationComparable(
  artifact: SfnsPinnedChromiumValidationArtifact,
  observation: SfnsValidationObservation,
): ComparableObservation {
  const evidence = selectedValidationEvidence(observation);
  const raw = evidence.raw.payload as SfnsRawPayload;
  const filtered = evidence.filtered.payload as SfnsFilteredPayload;
  const run = evidence.run.payload as SfnsRunPayload;
  const maskPayloads = evidence.masks.map((event) => event.payload as SfnsMaskPayload);
  const masks = new Map(maskPayloads.map((mask) => [mask.glyph.packedId, mask]));
  const firstMask = maskPayloads[0];
  const gamma = firstMask?.gamma;
  return {
    source: {
      chromiumRevision: evidence.run.source.chromiumRevision,
      skiaRevision: evidence.run.source.skiaRevision,
      fontPath: artifact.corpus.fontPath,
      fontByteLength: evidence.run.source.sourceFontByteLength,
      fontSha256: evidence.run.source.sourceFontSha256,
    },
    typeface: {
      family: evidence.run.typeface.family,
      postscriptName: evidence.run.typeface.postscriptName,
      style: evidence.run.typeface.style,
      axes: normalizeValidationAxes(evidence.run),
    },
    font: normalizeFont(raw.font),
    paint: normalizePaint(raw.paint),
    surfaceProps: normalizeSurface(raw.surfaceProps),
    scalerContextFlags: raw.scalerContextFlags,
    rawRec: recordWithoutRuntimeTypeface(raw.rawRec),
    filteredRec: recordWithoutRuntimeTypeface(filtered.after),
    matrices: {
      total: filtered.matrices.total,
      scale: filtered.matrices.scale,
      remaining: filtered.matrices.remaining,
      remainingWithoutRotation: filtered.matrices.remainingWithoutRotation,
      remainingRotation: filtered.matrices.remainingRotation,
      invertible: filtered.matrices.invertible,
    },
    smoothBehavior: filtered.smoothBehavior,
    // Validation schema v1 did not retain the gamma table itself. Keep every
    // available field exact and represent absent required facts as null, so an
    // incomplete artifact cannot pass by omission.
    gamma: {
      inputContrast: value(raw.surfaceProps, "textContrast"),
      inputDeviceGamma: value(raw.surfaceProps, "textGamma"),
      tableApplicable: null,
      tableWidth: null,
      tableHeight: null,
      tableByteLength: null,
      tableSha256: null,
      preblendApplicable: gamma == null ? null : value(gamma, "preblendApplicable"),
      preblendR256Sha256: gamma == null ? null : value(gamma, "preblendR256Sha256"),
      preblendG256Sha256: gamma == null ? null : value(gamma, "preblendG256Sha256"),
      preblendB256Sha256: gamma == null ? null : value(gamma, "preblendB256Sha256"),
    },
    fontMetrics: normalizedValidationMetrics(firstMask),
    glyphs: run.glyphs.map((glyph) => validationGlyph(glyph, run.rounding, masks)),
  };
}

function addComparison(
  mismatches: ExactMismatch[],
  caseId: string,
  observationPair: string,
  group: string,
  proposal: unknown,
  validation: unknown,
): void {
  if (exact(proposal, validation)) return;
  mismatches.push({
    caseId,
    observationPair,
    group,
    proposalDigest: hashJson(proposal),
    validationDigest: hashJson(validation),
  });
}

function compareObservation(
  caseId: string,
  proposalObservation: SfnsPinnedObservation,
  validationArtifact: SfnsPinnedChromiumValidationArtifact,
  validationObservation: SfnsValidationObservation,
  mismatches: ExactMismatch[],
): ObservationPairResult {
  const pair = `${proposalObservation.observationId}::${validationObservation.observationId}`;
  const before = mismatches.length;
  addComparison(
    mismatches,
    caseId,
    pair,
    "observation-identity",
    { distinct: proposalObservation.observationId !== validationObservation.observationId },
    { distinct: true },
  );
  const proposal = proposalComparable(proposalObservation);
  const validation = validationComparable(validationArtifact, validationObservation);
  for (const group of [
    "source", "typeface", "font", "paint", "surfaceProps", "scalerContextFlags",
    "rawRec", "filteredRec", "matrices", "smoothBehavior", "gamma", "fontMetrics",
  ] as const) {
    addComparison(mismatches, caseId, pair, group, proposal[group], validation[group]);
  }
  addComparison(mismatches, caseId, pair, "glyph-count", proposal.glyphs.length, validation.glyphs.length);
  const count = Math.max(proposal.glyphs.length, validation.glyphs.length);
  for (let index = 0; index < count; index += 1) {
    const left = proposal.glyphs[index];
    const right = validation.glyphs[index];
    for (const group of ["identity", "advance", "offset", "placement", "phase", "metrics", "mask"] as const) {
      addComparison(
        mismatches,
        caseId,
        pair,
        `glyph-${index}-${group}`,
        left?.[group] ?? null,
        right?.[group] ?? null,
      );
    }
  }
  return {
    caseId,
    proposalObservationId: proposalObservation.observationId,
    validationObservationId: validationObservation.observationId,
    mismatchGroups: mismatches.slice(before).map((mismatch) => mismatch.group),
  };
}

function reportDigest(
  report: Omit<SfnsTerminalMaskAdjudicationReport, "reportDigest">
    | SfnsTerminalMaskAdjudicationReport,
): string {
  const { reportDigest: ignored, ...payload } = report as SfnsTerminalMaskAdjudicationReport;
  void ignored;
  return hashJson(payload);
}

function defaultIdentity(label: string, artifact: unknown): InputFileIdentity {
  const serialized = JSON.stringify(artifact);
  return { path: `<${label}:in-memory>`, sha256: shaBytes(serialized) };
}

export function adjudicateSfnsTerminalMasks(
  proposal: SfnsPinnedSkiaProposalArtifact,
  validation: SfnsPinnedChromiumValidationArtifact,
  proposalFile = defaultIdentity("proposal", proposal),
  validationFile = defaultIdentity("validation", validation),
): SfnsTerminalMaskAdjudicationReport {
  const inputIntegrityErrors = [
    ...validateSfnsPinnedSkiaProposal(proposal).map((error) => `proposal:${error}`),
    ...validateSfnsPinnedChromiumValidation(validation).map((error) => `validation:${error}`),
  ];
  const proposalBuildIdentity = hashJson(proposal.build);
  const validationBuildIdentity = hashJson(validation.build);
  const distinctAuthorities = proposal.authority !== validation.authority;
  const distinctBuildIdentities = proposalBuildIdentity !== validationBuildIdentity;
  const distinctBinaryDigests = proposal.build.binary.sha256 !== validation.build.binary.sha256;
  if (!distinctAuthorities) inputIntegrityErrors.push("independence:same-authority");
  if (!distinctBuildIdentities) inputIntegrityErrors.push("independence:same-build-identity");
  if (!distinctBinaryDigests) inputIntegrityErrors.push("independence:same-binary-digest");
  if (!exact(proposal.scenarios.map((scenario) => scenario.id), SFNS_PINNED_SCENARIOS)) {
    inputIntegrityErrors.push("proposal:scenario-order");
  }
  if (!exact(validation.scenarios.map((scenario) => scenario.id), SFNS_VALIDATION_SCENARIOS)) {
    inputIntegrityErrors.push("validation:scenario-order");
  }
  if (!exact(proposal.controls.map((control) => control.id), SFNS_CONTROL_IDS)) {
    inputIntegrityErrors.push("proposal:control-order");
  }
  if (!exact(validation.controls.map((control) => control.id), SFNS_VALIDATION_CONTROLS)) {
    inputIntegrityErrors.push("validation:control-order");
  }

  const mismatches: ExactMismatch[] = [];
  const observationPairs: ObservationPairResult[] = [];
  if (inputIntegrityErrors.length === 0) {
    try {
      for (const id of SFNS_PINNED_SCENARIOS) {
        const proposalScenario = proposal.scenarios.find((scenario) => scenario.id === id)!;
        const validationScenario = validation.scenarios.find((scenario) => scenario.id === id)!;
        for (let index = 0; index < 4; index += 1) {
          observationPairs.push(compareObservation(
            id,
            proposalScenario.observations[index],
            validation,
            validationScenario.observations[index],
            mismatches,
          ));
        }
      }
      for (const id of SFNS_CONTROL_IDS) {
        const proposalControl = proposal.controls.find((control) => control.id === id)!;
        const validationControl = validation.controls.find((control) => control.id === id)!;
        observationPairs.push(compareObservation(
          `control-${id}`,
          proposalControl.observation,
          validation,
          validationControl.observation,
          mismatches,
        ));
      }
    } catch (error) {
      inputIntegrityErrors.push(
        `cross-arm-extraction:${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const proposalIds = new Set(
    proposal.scenarios.flatMap((scenario) => scenario.observations.map((observation) => observation.observationId))
      .concat(proposal.controls.map((control) => control.observation.observationId)),
  );
  const validationIds = validation.scenarios
    .flatMap((scenario) => scenario.observations.map((observation) => observation.observationId))
    .concat(validation.controls.map((control) => control.observation.observationId));
  const distinctObservationIds = validationIds.every((id) => !proposalIds.has(id));
  if (!distinctObservationIds) {
    inputIntegrityErrors.push("independence:observation-id-overlap");
  }

  const proposalCancellation = proposal.scenarios
    .find((scenario) => scenario.id === "zoom-2-transform-half")?.observations
    .map((observation) => observation.matrices.scale) ?? [];
  const validationCancellation = validation.scenarios
    .find((scenario) => scenario.id === "zoom-2-transform-half")?.observations
    .map((observation) => {
      const filtered = selectedValidationEvidence(observation).filtered.payload as SfnsFilteredPayload;
      return filtered.matrices.scale;
    }) ?? [];
  const exactCancellation = proposalCancellation.length === 4
    && validationCancellation.length === 4
    && [...proposalCancellation, ...validationCancellation]
      .every((scale) => exact(scale, [13, 13]));
  if (!exactCancellation) inputIntegrityErrors.push("cancellation:not-exact-13px-scaler");

  const payload: Omit<SfnsTerminalMaskAdjudicationReport, "reportDigest"> = {
    schemaVersion: 1,
    authority: "exact-cross-arm-adjudication",
    adjudicatorAbi: SFNS_TERMINAL_ADJUDICATOR_ABI,
    contract: {
      equality: "exact-logical-fields-and-bytes-no-tolerance",
      recNormalization: "zero-only-process-local-four-byte-typeface-id",
      productionRenderingChanges: false,
      browserLaunches: 0,
    },
    inputs: {
      proposal: {
        ...proposalFile,
        authority: proposal.authority,
        artifactDigest: proposal.artifactDigest,
        recomputedArtifactDigest: sfnsPinnedArtifactDigest(proposal),
        buildIdentity: proposalBuildIdentity,
        binarySha256: proposal.build.binary.sha256,
      },
      validation: {
        ...validationFile,
        authority: validation.authority,
        artifactDigest: validation.artifactDigest,
        recomputedArtifactDigest: sfnsValidationArtifactDigest(validation),
        buildIdentity: validationBuildIdentity,
        binarySha256: validation.build.binary.sha256,
      },
    },
    independence: {
      distinctAuthorities,
      distinctBuildIdentities,
      distinctBinaryDigests,
      distinctObservationIds,
    },
    cancellationDecision: {
      required: "13px-scaler-not-26px-later-resample",
      requiredScale: [13, 13],
      proposalScales: proposalCancellation,
      validationScales: validationCancellation,
      exact: exactCancellation,
    },
    observationPairs,
    inputIntegrityErrors: [...new Set(inputIntegrityErrors)],
    mismatches,
    ready: inputIntegrityErrors.length === 0 && mismatches.length === 0,
  };
  return { ...payload, reportDigest: reportDigest(payload) };
}

function argumentValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index < 0 ? undefined : argv[index + 1];
}

function readArtifact<T>(path: string): { artifact: T; file: InputFileIdentity } {
  const absolutePath = resolve(path);
  const bytes = readFileSync(absolutePath);
  return {
    artifact: JSON.parse(bytes.toString("utf8")) as T,
    file: { path, sha256: shaBytes(bytes) },
  };
}

function runCli(): void {
  const argv = process.argv.slice(2);
  const proposalPath = argumentValue(argv, "--proposal");
  const validationPath = argumentValue(argv, "--validation");
  if (proposalPath == null || validationPath == null) {
    throw new Error("--proposal and --validation artifact paths are required");
  }
  const proposal = readArtifact<SfnsPinnedSkiaProposalArtifact>(proposalPath);
  const validation = readArtifact<SfnsPinnedChromiumValidationArtifact>(validationPath);
  const report = adjudicateSfnsTerminalMasks(
    proposal.artifact,
    validation.artifact,
    proposal.file,
    validation.file,
  );
  const reportPath = argumentValue(argv, "--report");
  if (reportPath != null) {
    writeFileSync(resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`);
  }
  const summary = `SFNS terminal-mask adjudication: ${report.ready ? "READY" : "NOT READY"}; `
    + `${report.observationPairs.length} observation pairs, `
    + `${report.inputIntegrityErrors.length} integrity errors, `
    + `${report.mismatches.length} exact mismatches; report ${report.reportDigest}`;
  console.log(summary);
  if (!report.ready && !argv.includes("--allow-not-ready")) process.exitCode = 1;
}

const isMain = process.argv[1] != null && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) runCli();
