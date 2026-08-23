/**
 * Portable, source-owned sensitivity rows for the exact shaping gate.
 *
 * Host font inventories are evidence, not a portable test corpus: the Noble
 * arm64 image used by the release gate contains only static faces, so it cannot
 * prove that variable coordinates or `ptem` reached HarfBuzz. These fixtures
 * exercise omission-shaped destructive controls while retaining the exact
 * logical-stream comparison used by the main oracle. Pixels are intentionally
 * outside this gate.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { BufferFlag, ClusterLevel } from "../vendor/harfbuzzjs/dist/index.mjs";
import {
  harfbuzzGlyphQuery,
  harfbuzzShapeRun,
  registerHbBufferSource,
  type ShapeResult,
} from "../src/render/harfbuzz-shaper.js";

export const DEFAULT_VARIABLE_FIXTURE = "tests/fixtures/variable-axis/variable-axis.html";
export const DEFAULT_TRACKING_FIXTURE = "tests/fixtures/exact-shaping/TRAK.ttf.base64";
export const VARIABLE_FIXTURE_SHA256 = "c8886233e48f9757d48028f9517bcbe97603e685c31a49eb3a596461621f4a5a";
export const TRACKING_FIXTURE_SHA256 = "cf3fdeb89ad8e723633fa7f364d0c0097448236884a8299a41a106904c50b7be";

export type ApplicableShapingControl = "axes" | "ptem";
export type ControlApplicability = "applicable" | "inapplicable";
export type ControlMovement =
  | "moved-as-expected"
  | "non-moving"
  | "unexpected-logical-change"
  | "not-run";

export interface ExactControlGlyph {
  id: number;
  cluster: number;
  sourceSpan: [number, number];
  xAdvance: number;
  yAdvance: number;
  xOffset: number;
  yOffset: number;
  flags: number;
  unsafeToBreak: boolean;
}

export interface ExactControlLogicalStream {
  logicalSha256: string;
  glyphs: ExactControlGlyph[];
}

export interface ExactControlState {
  fontSizePx: number | null;
  axes: Record<string, number> | null;
  expected: ExactControlLogicalStream;
  actual: ExactControlLogicalStream | null;
}

export interface ExactControlFixture {
  path: string;
  expectedSha256: string;
  decodedSha256: string | null;
  upstreamRepository: string;
  upstreamRevision: string;
  upstreamPath: string;
  upstreamBlob: string;
  license: string;
  tables: string[];
  requiredTables: string[];
}

export interface ApplicableShapingControlRow {
  id: string;
  control: ApplicableShapingControl;
  required: true;
  fixture: ExactControlFixture;
  input: { text: string; direction: "ltr"; script: "Latn"; language: "en" };
  baseline: ExactControlState;
  destructiveMutation: ExactControlState;
  expectedChangedFields: ["xAdvance"];
  changedFields: string[];
  applicability: { status: ControlApplicability; reason: string | null };
  movement: { status: ControlMovement; reason: string | null };
  applicable: boolean;
  movementProven: boolean;
  rasterization: "out-of-scope";
}

export interface ApplicableShapingControlReport {
  controlRows: ApplicableShapingControlRow[];
  controlHits: Record<ApplicableShapingControl, number>;
  missedControls: ApplicableShapingControl[];
  inapplicableControls: string[];
  nonMovingControls: string[];
  unexpectedControls: string[];
  failedControls: string[];
}

interface ControlSpec {
  id: string;
  control: ApplicableShapingControl;
  text: string;
  baselineFontSizePx: number | null;
  baselineAxes: Record<string, number> | null;
  baselineGlyphs: ExactControlGlyph[];
  mutationFontSizePx: number | null;
  mutationAxes: Record<string, number> | null;
  mutationGlyphs: ExactControlGlyph[];
}

interface FixtureSpec {
  path: string;
  expectedSha256: string;
  upstreamRepository: string;
  upstreamRevision: string;
  upstreamPath: string;
  upstreamBlob: string;
  license: string;
  requiredTables: string[];
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function logicalStream(glyphs: ExactControlGlyph[]): ExactControlLogicalStream {
  return { logicalSha256: sha256(JSON.stringify(glyphs)), glyphs };
}

function asciiGlyphs(ids: number[], xAdvances: number[]): ExactControlGlyph[] {
  return ids.map((id, index) => ({
    id,
    cluster: index,
    sourceSpan: [index, index + 1],
    xAdvance: xAdvances[index],
    yAdvance: 0,
    xOffset: 0,
    yOffset: 0,
    flags: 0,
    unsafeToBreak: false,
  }));
}

const OPEN_SANS_IDS = [43, 68, 80, 69, 88, 85, 74, 72, 73, 82, 81, 86, 87, 76, 89];
const OPEN_SANS_DEFAULT = asciiGlyphs(
  OPEN_SANS_IDS,
  [1510, 1138, 1896, 1253, 1256, 837, 1112, 1150, 689, 1232, 1256, 976, 730, 517, 1023],
);
const OPEN_SANS_WGHT_800 = asciiGlyphs(
  OPEN_SANS_IDS,
  [1569, 1276, 2048, 1317, 1372, 961, 1241, 1266, 846, 1305, 1372, 1059, 942, 666, 1251],
);
const OPEN_SANS_WDTH_75 = asciiGlyphs(
  OPEN_SANS_IDS,
  [1081, 841, 1380, 937, 923, 614, 790, 847, 509, 902, 923, 688, 519, 424, 741],
);
const TRAK_PTEM_9 = asciiGlyphs([5, 3, 7], [1060, 1060, 1060]);
const TRAK_PTEM_UNSET = asciiGlyphs([5, 3, 7], [1000, 1000, 1000]);

const VARIABLE_SPECS: ControlSpec[] = [
  {
    id: "open-sans-wght-800-to-default",
    control: "axes",
    text: "Hamburgefonstiv",
    baselineFontSizePx: 48,
    baselineAxes: { wght: 800, wdth: 100 },
    baselineGlyphs: OPEN_SANS_WGHT_800,
    mutationFontSizePx: 48,
    mutationAxes: null,
    mutationGlyphs: OPEN_SANS_DEFAULT,
  },
  {
    id: "open-sans-wdth-75-to-default",
    control: "axes",
    text: "Hamburgefonstiv",
    baselineFontSizePx: 48,
    baselineAxes: { wght: 400, wdth: 75 },
    baselineGlyphs: OPEN_SANS_WDTH_75,
    mutationFontSizePx: 48,
    mutationAxes: null,
    mutationGlyphs: OPEN_SANS_DEFAULT,
  },
];

const TRACKING_SPECS: ControlSpec[] = [
  {
    id: "harfbuzz-trak-ptem-9-to-unset",
    control: "ptem",
    text: "ABC",
    baselineFontSizePx: 9,
    baselineAxes: null,
    baselineGlyphs: TRAK_PTEM_9,
    mutationFontSizePx: null,
    mutationAxes: null,
    mutationGlyphs: TRAK_PTEM_UNSET,
  },
];

export function sfntTableTags(bytes: Uint8Array): string[] {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (data.length < 12) throw new Error("exact-shaping fixture is not an sfnt");
  const count = data.readUInt16BE(4);
  if (data.length < 12 + count * 16) throw new Error("exact-shaping fixture has a truncated table directory");
  const tags: string[] = [];
  for (let index = 0; index < count; index++) {
    tags.push(data.subarray(12 + index * 16, 16 + index * 16).toString("ascii"));
  }
  return tags.sort();
}

export function embeddedVariableFontBytes(path = DEFAULT_VARIABLE_FIXTURE): Buffer {
  const html = readFileSync(resolve(path), "utf8");
  const match = html.match(/data:font\/ttf;base64,([A-Za-z0-9+/=]+)/);
  if (match == null) throw new Error(`${path} has no embedded TrueType fixture`);
  return Buffer.from(match[1], "base64");
}

export function encodedTrackingFontBytes(path = DEFAULT_TRACKING_FIXTURE): Buffer {
  return Buffer.from(readFileSync(resolve(path), "utf8").replace(/\s+/g, ""), "base64");
}

function sourceEnd(text: string, cluster: number, clusters: number[]): number {
  const later = clusters.filter((candidate) => candidate > cluster);
  return later.length > 0 ? Math.min(...later) : text.length;
}

function exactGlyphs(result: ShapeResult, text: string): ExactControlGlyph[] {
  return result.glyphs.map((glyph, index) => ({
    id: glyph.id,
    cluster: result.clusters[index],
    sourceSpan: [
      result.clusters[index],
      sourceEnd(text, result.clusters[index], result.clusters),
    ],
    xAdvance: result.positions[index].xAdvance,
    yAdvance: result.positions[index].yAdvance,
    xOffset: result.positions[index].xOffset,
    yOffset: result.positions[index].yOffset,
    flags: result.glyphFlags[index],
    unsafeToBreak: (result.glyphFlags[index] & 1) !== 0,
  }));
}

const EXACT_FIELDS = [
  "id",
  "cluster",
  "sourceSpan",
  "xAdvance",
  "yAdvance",
  "xOffset",
  "yOffset",
  "flags",
  "unsafeToBreak",
] as const;

export function changedExactFields(baseline: ExactControlGlyph[], mutation: ExactControlGlyph[]): string[] {
  const changed: string[] = [];
  if (baseline.length !== mutation.length) changed.push("glyphCount");
  for (const field of EXACT_FIELDS) {
    if (JSON.stringify(baseline.map((glyph) => glyph[field])) !== JSON.stringify(mutation.map((glyph) => glyph[field]))) {
      changed.push(field);
    }
  }
  return changed;
}

function shape(
  bytes: Buffer,
  text: string,
  fontSizePx: number | null,
  axes: Record<string, number> | null,
): ShapeResult {
  const path = registerHbBufferSource(bytes);
  const result = harfbuzzShapeRun(path, 0, text, "ltr", fontSizePx ?? undefined, axes, undefined, {
    script: "Latn",
    language: "en",
    bufferFlags: BufferFlag.BOT | BufferFlag.EOT,
    clusterLevel: ClusterLevel.MONOTONE_CHARACTERS,
  });
  if (result == null) throw new Error("exact-shaping fixture could not be shaped");
  return result;
}

function inspectFixture(
  source: () => Buffer,
  fixture: FixtureSpec,
): { bytes: Buffer | null; metadata: ExactControlFixture; reason: string | null } {
  let bytes: Buffer;
  try {
    bytes = source();
  } catch (error) {
    return {
      bytes: null,
      metadata: { ...fixture, decodedSha256: null, tables: [] },
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  const decodedSha256 = sha256(bytes);
  let tables: string[] = [];
  try {
    tables = sfntTableTags(bytes);
  } catch (error) {
    return {
      bytes: null,
      metadata: { ...fixture, decodedSha256, tables },
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (decodedSha256 !== fixture.expectedSha256) {
    return {
      bytes: null,
      metadata: { ...fixture, decodedSha256, tables },
      reason: `decoded SHA-256 ${decodedSha256} does not match pinned ${fixture.expectedSha256}`,
    };
  }
  const missing = fixture.requiredTables.filter((table) => !tables.includes(table));
  if (missing.length > 0) {
    return {
      bytes: null,
      metadata: { ...fixture, decodedSha256, tables },
      reason: `missing required tables: ${missing.join(", ")}`,
    };
  }
  return { bytes, metadata: { ...fixture, decodedSha256, tables }, reason: null };
}

function expectedState(
  fontSizePx: number | null,
  axes: Record<string, number> | null,
  glyphs: ExactControlGlyph[],
): ExactControlState {
  return { fontSizePx, axes, expected: logicalStream(glyphs), actual: null };
}

function inapplicableRow(
  spec: ControlSpec,
  fixture: ExactControlFixture,
  reason: string,
): ApplicableShapingControlRow {
  return {
    id: spec.id,
    control: spec.control,
    required: true,
    fixture,
    input: { text: spec.text, direction: "ltr", script: "Latn", language: "en" },
    baseline: expectedState(spec.baselineFontSizePx, spec.baselineAxes, spec.baselineGlyphs),
    destructiveMutation: expectedState(spec.mutationFontSizePx, spec.mutationAxes, spec.mutationGlyphs),
    expectedChangedFields: ["xAdvance"],
    changedFields: [],
    applicability: { status: "inapplicable", reason },
    movement: { status: "not-run", reason: "fixture prerequisites were not satisfied" },
    applicable: false,
    movementProven: false,
    rasterization: "out-of-scope",
  };
}

function runControl(
  spec: ControlSpec,
  bytes: Buffer,
  fixture: ExactControlFixture,
): ApplicableShapingControlRow {
  const input = { text: spec.text, direction: "ltr" as const, script: "Latn" as const, language: "en" as const };
  const baseline = expectedState(spec.baselineFontSizePx, spec.baselineAxes, spec.baselineGlyphs);
  const destructiveMutation = expectedState(spec.mutationFontSizePx, spec.mutationAxes, spec.mutationGlyphs);
  const path = registerHbBufferSource(bytes);
  const query = harfbuzzGlyphQuery(path, 0);
  if (query == null || [...spec.text].some((character) => query.nominalGlyph(character.codePointAt(0)!) === 0)) {
    return inapplicableRow(spec, fixture, "fixture does not cover its declared text");
  }

  let baselineGlyphs: ExactControlGlyph[];
  let mutationGlyphs: ExactControlGlyph[];
  try {
    baselineGlyphs = exactGlyphs(shape(bytes, spec.text, spec.baselineFontSizePx, spec.baselineAxes), spec.text);
    mutationGlyphs = exactGlyphs(shape(bytes, spec.text, spec.mutationFontSizePx, spec.mutationAxes), spec.text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ...inapplicableRow(spec, fixture, "fixture prerequisites were satisfied"),
      applicability: { status: "applicable", reason: null },
      applicable: true,
      movement: { status: "unexpected-logical-change", reason },
    };
  }

  baseline.actual = logicalStream(baselineGlyphs);
  destructiveMutation.actual = logicalStream(mutationGlyphs);
  const changedFields = changedExactFields(baselineGlyphs, mutationGlyphs);
  const changedExactlyAsExpected = JSON.stringify(changedFields) === JSON.stringify(["xAdvance"]);
  const baselineExact = baseline.actual.logicalSha256 === baseline.expected.logicalSha256;
  const mutationExact = destructiveMutation.actual.logicalSha256 === destructiveMutation.expected.logicalSha256;
  const movementStatus: ControlMovement = changedFields.length === 0
    ? "non-moving"
    : changedExactlyAsExpected && baselineExact && mutationExact
      ? "moved-as-expected"
      : "unexpected-logical-change";
  const mismatches = [
    !changedExactlyAsExpected ? `changed fields were [${changedFields.join(", ")}]` : null,
    !baselineExact ? `baseline digest ${baseline.actual.logicalSha256} != ${baseline.expected.logicalSha256}` : null,
    !mutationExact ? `destructive mutation digest ${destructiveMutation.actual.logicalSha256} != ${destructiveMutation.expected.logicalSha256}` : null,
  ].filter((reason): reason is string => reason != null);
  return {
    id: spec.id,
    control: spec.control,
    required: true,
    fixture,
    input,
    baseline,
    destructiveMutation,
    expectedChangedFields: ["xAdvance"],
    changedFields,
    applicability: { status: "applicable", reason: null },
    movement: {
      status: movementStatus,
      reason: movementStatus === "moved-as-expected" ? null
        : movementStatus === "non-moving" ? "destructive omission did not change the logical stream"
          : mismatches.join("; "),
    },
    applicable: true,
    movementProven: movementStatus === "moved-as-expected",
    rasterization: "out-of-scope",
  };
}

function runFixtureGroup(
  specs: ControlSpec[],
  source: () => Buffer,
  fixture: FixtureSpec,
): ApplicableShapingControlRow[] {
  const inspected = inspectFixture(source, fixture);
  if (inspected.bytes == null || inspected.reason != null) {
    return specs.map((spec) => inapplicableRow(spec, inspected.metadata, inspected.reason ?? "fixture is unavailable"));
  }
  return specs.map((spec) => runControl(spec, inspected.bytes, inspected.metadata));
}

/**
 * Run the platform-independent controls the host inventory cannot promise.
 *
 * Each baseline applies a truthful source-owned input. Its destructive pair
 * omits that input (non-default axes -> defaults, ptem 9 -> unset). A row passes
 * only when the complete pinned logical streams match and `xAdvance` is the one
 * and only changed field. Invalid fixtures are reported as inapplicable instead
 * of throwing before the caller can write its evidence artifact.
 */
export function runApplicableShapingControls(options: {
  variableFixture?: string;
  trackingFixture?: string;
} = {}): ApplicableShapingControlReport {
  const variablePath = options.variableFixture ?? DEFAULT_VARIABLE_FIXTURE;
  const trackingPath = options.trackingFixture ?? DEFAULT_TRACKING_FIXTURE;
  const controlRows = [
    ...runFixtureGroup(VARIABLE_SPECS, () => embeddedVariableFontBytes(variablePath), {
      path: variablePath,
      expectedSha256: VARIABLE_FIXTURE_SHA256,
      upstreamRepository: "https://github.com/google/fonts",
      upstreamRevision: "repository-owned deterministic subset from google/fonts main",
      upstreamPath: "ofl/opensans/OpenSans[wdth,wght].ttf",
      upstreamBlob: `local-subset-sha256:${VARIABLE_FIXTURE_SHA256}`,
      license: "SIL Open Font License 1.1",
      requiredTables: ["fvar", "gvar"],
    }),
    ...runFixtureGroup(TRACKING_SPECS, () => encodedTrackingFontBytes(trackingPath), {
      path: trackingPath,
      expectedSha256: TRACKING_FIXTURE_SHA256,
      upstreamRepository: "https://github.com/harfbuzz/harfbuzz",
      upstreamRevision: "4de187dd0a915d13c976fa8bd474c084229f3aab",
      upstreamPath: "test/shape/data/in-house/fonts/TRAK.ttf",
      upstreamBlob: "3be9c0085421079272ddfbffc352862bbf0d0e9b",
      license: "SIL Open Font License 1.1",
      requiredTables: ["STAT", "trak"],
    }),
  ];
  const controlHits = {
    axes: controlRows.filter((row) => row.control === "axes" && row.movementProven).length,
    ptem: controlRows.filter((row) => row.control === "ptem" && row.movementProven).length,
  };
  const inapplicableControls = controlRows.filter((row) => !row.applicable).map((row) => row.id);
  const nonMovingControls = controlRows.filter((row) => row.movement.status === "non-moving").map((row) => row.id);
  const unexpectedControls = controlRows.filter((row) => row.movement.status === "unexpected-logical-change").map((row) => row.id);
  const failedControls = controlRows.filter((row) => !row.movementProven).map((row) => row.id);
  return {
    controlRows,
    controlHits,
    missedControls: (["axes", "ptem"] as const).filter((control) => controlHits[control] === 0),
    inapplicableControls,
    nonMovingControls,
    unexpectedControls,
    failedControls,
  };
}
