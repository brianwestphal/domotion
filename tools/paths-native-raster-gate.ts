import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { assessPathsNativeFaceIdentity, pathsRasterCssFamily } from "./paths-native-face-identity.js";

const finite = z.number().finite();
const fingerprintSchema = z.object({
  platform: z.enum(["darwin", "linux", "win32"]), osImage: z.string().min(1), osImageVersion: z.string().min(1), arch: z.string().min(1),
  osRelease: z.string().min(1), chromium: z.string().min(1), chromiumRevision: z.string().min(1),
  browserExecutableSha256: z.string().regex(/^[a-f0-9]{64}$/),
  nativeIdentityHelperSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  // Chromium does not expose the embedded Skia/HarfBuzz revisions at runtime.
  // These fields therefore identify the authenticated browser binary that owns
  // those libraries; the source revisions used by the logical oracle are kept
  // separately and must never be presented as binary provenance.
  skia: z.string().min(1), harfbuzz: z.string().min(1),
  oracleSkiaRevision: z.string().min(1), oracleHarfbuzzRevision: z.string().min(1),
  fontInventorySha256: z.string().regex(/^[a-f0-9]{64}$/),
  rendererSourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  oracleSourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  consumerRasterizer: z.string().min(1), playwrightVersion: z.string().min(1),
  nodeVersion: z.string().min(1), icuVersion: z.string().min(1), sharpVersion: z.string().min(1),
  libvipsVersion: z.string().min(1), metricAlgorithm: z.string().min(1),
  launchFlags: z.array(z.string()), locale: z.string().min(1),
}).strict().superRefine((fingerprint, ctx) => {
  if (fingerprint.platform === "win32" && fingerprint.nativeIdentityHelperSha256 == null) {
    ctx.addIssue({ code: "custom", message: "Windows observations require the DirectWrite identity-helper fingerprint" });
  }
  if (fingerprint.platform !== "win32" && fingerprint.nativeIdentityHelperSha256 != null) {
    ctx.addIssue({ code: "custom", message: "only Windows observations may carry a DirectWrite identity-helper fingerprint" });
  }
});
const glyphSchema = z.object({
  gid: z.number().int().nonnegative(), cluster: z.number().int().nonnegative(),
  advanceX: finite, advanceY: finite, offsetX: finite, offsetY: finite,
  outlineSha256: z.string().regex(/^[a-f0-9]{64}$/), outlineCommandCount: z.number().int().positive(),
}).strict();
const logicalSchema = z.object({
  postscriptName: z.string().min(1), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/), faceIndex: z.number().int().nonnegative(),
  variationAxes: z.record(z.string(), finite), glyphs: z.array(glyphSchema).min(1), baseline: finite,
  matrix: z.tuple([finite, finite, finite, finite, finite, finite]),
  paintPlan: z.object({ syntheticBold: z.boolean(), syntheticOblique: z.boolean() }).strict(),
}).strict();
const helperFaceSchema = z.object({
  postscriptDisplayName: z.string(), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  faceIndex: z.number().int().nonnegative(), resolvedAxes: z.record(z.string(), finite),
  platformResolvedAxes: z.record(z.string(), finite).optional(),
  helperSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const nativeFaceSchema = z.object({
  requestedFamily: z.string().min(1), computedFamily: z.string().min(1),
  fontFaceRuleFamily: z.string().min(1), fontFaceRuleCount: z.number().int().positive(),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/), computedVariationAxes: z.record(z.string(), finite),
  paintedFamilyDisplayName: z.string(),
  postscriptDisplayName: z.string(), isCustomFont: z.boolean(),
  glyphCount: z.number().int().positive(), helper: helperFaceSchema.optional(),
}).strict();
const dimensionsSchema = z.object({
  fontTechnology: z.enum(["glyf-hinted", "glyf-unhinted", "cff", "cff2", "variable-glyf", "variable-cff2"]),
  fontSizePx: finite.positive(), weight: z.number().int().min(1).max(1000), phaseX: finite, phaseY: finite,
  transform: z.enum(["none", "translate", "scale", "rotate", "affine"]), deviceScaleFactor: z.union([z.literal(1), z.literal(2)]),
}).strict();
const inkGeometrySchema = z.object({
  area: z.number().int().nonnegative(), x: z.number().int(), y: z.number().int(),
  width: z.number().int().nonnegative(), height: z.number().int().nonnegative(),
}).strict();
const envelopeResidualSchema = z.object({
  changedPixels: z.number().int().nonnegative(), area: z.number().int().nonnegative(),
  width: z.number().int().nonnegative(), height: z.number().int().nonnegative(),
  maxEdgeDistance: finite.nonnegative(), severity: finite.nonnegative(),
  totalChannelDelta: z.number().int().nonnegative(),
}).strict();
const residualSchema = envelopeResidualSchema.extend({
  nativeInk: inkGeometrySchema,
  pathsInk: inkGeometrySchema,
}).strict();
const artifactSchema = z.object({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/), width: z.number().int().positive(), height: z.number().int().positive() }).strict();
export const pathsRasterRowSchema = z.object({
  id: z.string().min(1), runLabel: z.enum(["proposal", "validation"]),
  runProvenance: z.object({
    githubRunId: z.string().min(1), githubRunAttempt: z.string().min(1), githubJob: z.string().min(1),
    runnerName: z.string().min(1), workflowRef: z.string().min(1),
  }).strict(),
  cellSha256: z.string().regex(/^[a-f0-9]{64}$/), fingerprint: fingerprintSchema, dimensions: dimensionsSchema,
  expectedLogical: logicalSchema, actualLogical: logicalSchema, nativeFace: nativeFaceSchema, residual: residualSchema,
  nativeArtifact: artifactSchema, pathsArtifact: artifactSchema, warnings: z.array(z.string()),
}).strict();
export type PathsRasterRow = z.infer<typeof pathsRasterRowSchema>;

const envelopeSchema = z.object({
  key: z.string().min(1), fingerprintSha256: z.string().regex(/^[a-f0-9]{64}$/),
  cellSha256: z.string().regex(/^[a-f0-9]{64}$/), dimensions: dimensionsSchema,
  max: envelopeResidualSchema,
  // Proposal + independent validation, with role identity retained so a
  // native/paths swap cannot exploit symmetric residual metrics.
  reviewedArtifacts: z.object({
    proposal: z.object({ native: z.string().regex(/^[a-f0-9]{64}$/), paths: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    validation: z.object({ native: z.string().regex(/^[a-f0-9]{64}$/), paths: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  }).strict(),
}).strict();
export const envelopeFileSchema = z.object({ schemaVersion: z.literal(2), ratified: z.boolean(), reviewer: z.string().min(1).optional(), reviewedAt: z.string().datetime().optional(), envelopes: z.array(envelopeSchema) }).strict().superRefine((file, ctx) => {
  if (file.ratified && (file.reviewer == null || file.reviewedAt == null)) ctx.addIssue({ code: "custom", message: "ratified envelopes require reviewer and reviewedAt" });
  if (file.ratified && file.envelopes.length === 0) ctx.addIssue({ code: "custom", message: "ratified envelope file must contain reviewed rows" });
  const identities = new Set<string>();
  for (let i = 0; i < file.envelopes.length; i++) {
    const envelope = file.envelopes[i];
    if (envelope.key !== dimensionsKey(envelope.dimensions)) ctx.addIssue({ code: "custom", message: "envelope key does not match dimensions", path: ["envelopes", i, "key"] });
    const identity = `${envelope.fingerprintSha256}|${envelope.cellSha256}`;
    if (identities.has(identity)) ctx.addIssue({ code: "custom", message: "duplicate fingerprint/dimensions envelope", path: ["envelopes", i] });
    identities.add(identity);
    for (const [label, reviewed] of Object.entries(envelope.reviewedArtifacts)) {
      // Independent runs may be byte-identical; that is reproducibility, not
      // reuse.  What must remain distinct is each run's native-vs-path arm.
      if (reviewed.native === reviewed.paths) ctx.addIssue({
        code: "custom",
        message: `${label} native and paths artifact hashes must differ`,
        path: ["envelopes", i, "reviewedArtifacts", label],
      });
    }
  }
});

const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
  : value != null && typeof value === "object"
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, stable(entry)]))
    : value;
const canonical = (value: unknown): string => JSON.stringify(stable(value));
export const fingerprintSha256 = (fingerprint: PathsRasterRow["fingerprint"]): string => createHash("sha256").update(canonical(fingerprint)).digest("hex");
export const dimensionsKey = (dimensions: PathsRasterRow["dimensions"]): string => [dimensions.fontTechnology, dimensions.fontSizePx, dimensions.weight, dimensions.phaseX, dimensions.phaseY, dimensions.transform, dimensions.deviceScaleFactor].join("|");

function envelopeResidual(residual: PathsRasterRow["residual"]): z.infer<typeof envelopeResidualSchema> {
  const { changedPixels, area, width, height, maxEdgeDistance, severity, totalChannelDelta } = residual;
  return { changedPixels, area, width, height, maxEdgeDistance, severity, totalChannelDelta };
}

function assertRatifiedRunPairs(
  rows: PathsRasterRow[],
  envelopeFile: z.infer<typeof envelopeFileSchema>,
): void {
  if (!envelopeFile.ratified) return;
  const grouped = new Map<string, PathsRasterRow[]>();
  for (const row of rows) {
    const identity = `${fingerprintSha256(row.fingerprint)}|${row.cellSha256}`;
    const group = grouped.get(identity) ?? [];
    group.push(row); grouped.set(identity, group);
  }
  const envelopes = new Map(envelopeFile.envelopes.map((entry) => [`${entry.fingerprintSha256}|${entry.cellSha256}`, entry]));
  for (const [identity, group] of grouped) {
    const proposal = group.filter((row) => row.runLabel === "proposal");
    const validation = group.filter((row) => row.runLabel === "validation");
    if (proposal.length !== 1 || validation.length !== 1
        || proposal[0].runProvenance.runnerName === validation[0].runProvenance.runnerName) {
      throw new Error(`${identity}: ratified adjudication requires one proposal and one independent validation runner`);
    }
    const envelope = envelopes.get(identity);
    if (envelope != null && canonical(envelope.max) !== canonical(envelopeResidual(proposal[0].residual))) {
      throw new Error(`${identity}: ratified envelope max must equal the authenticated proposal residual`);
    }
  }
}

function firstLogicalMismatch(expected: PathsRasterRow["expectedLogical"], actual: PathsRasterRow["actualLogical"]): string | null {
  if (expected.postscriptName !== actual.postscriptName || expected.sourceSha256 !== actual.sourceSha256 || expected.faceIndex !== actual.faceIndex || canonical(expected.variationAxes) !== canonical(actual.variationAxes)) return "face-instance";
  if (canonical(expected.glyphs) !== canonical(actual.glyphs)) return "gid-cluster-advance-offset-outline";
  if (expected.baseline !== actual.baseline) return "baseline";
  if (canonical(expected.matrix) !== canonical(actual.matrix)) return "matrix";
  if (canonical(expected.paintPlan) !== canonical(actual.paintPlan)) return "paint-plan";
  return null;
}

export interface PathsRasterVerdict { id: string; verdict: "logical-mismatch" | "invalid-evidence" | "envelope-unratified" | "missing-envelope" | "envelope-violation" | "accepted-rasterization-only"; reason?: string }

export function adjudicatePathsRasterRows(rawRows: unknown, rawEnvelopes: unknown): { pass: boolean; rows: PathsRasterVerdict[] } {
  const rows = z.array(pathsRasterRowSchema).parse(rawRows);
  const envelopeFile = envelopeFileSchema.parse(rawEnvelopes);
  assertRatifiedRunPairs(rows, envelopeFile);
  const envelopes = new Map(envelopeFile.envelopes.map((entry) => [`${entry.fingerprintSha256}|${entry.cellSha256}`, entry]));
  const verdicts = rows.map((row): PathsRasterVerdict => {
    if (row.warnings.length > 0 || row.nativeArtifact.sha256 === row.pathsArtifact.sha256) return { id: row.id, verdict: "invalid-evidence", reason: row.warnings.length > 0 ? "warnings" : "inert-raster-arm" };
    const logical = firstLogicalMismatch(row.expectedLogical, row.actualLogical);
    if (logical != null) return { id: row.id, verdict: "logical-mismatch", reason: logical };
    const nativeIdentity = assessPathsNativeFaceIdentity({
      platform: row.fingerprint.platform,
      isVariable: row.dimensions.fontTechnology.startsWith("variable-"),
      expectedFamily: pathsRasterCssFamily(row.id),
      fingerprintHelperSha256: row.fingerprint.nativeIdentityHelperSha256,
      expected: row.expectedLogical,
      actual: row.actualLogical,
      native: row.nativeFace,
    });
    if (!nativeIdentity.pass) return {
      id: row.id,
      verdict: "invalid-evidence",
      reason: `native-face-identity:${nativeIdentity.blockers.join(",")}`,
    };
    if (!envelopeFile.ratified) return { id: row.id, verdict: "envelope-unratified" };
    const fingerprint = fingerprintSha256(row.fingerprint);
    const envelope = envelopes.get(`${fingerprint}|${row.cellSha256}`);
    if (envelope == null) return { id: row.id, verdict: "missing-envelope" };
    const reviewed = envelope.reviewedArtifacts[row.runLabel];
    if (reviewed.native !== row.nativeArtifact.sha256 || reviewed.paths !== row.pathsArtifact.sha256) return { id: row.id, verdict: "missing-envelope", reason: "unreviewed-artifact-role" };
    const r = row.residual, m = envelope.max;
    const inside = r.changedPixels <= m.changedPixels && r.area <= m.area && r.width <= m.width && r.height <= m.height
      && r.maxEdgeDistance <= m.maxEdgeDistance && r.severity <= m.severity
      && r.totalChannelDelta <= m.totalChannelDelta;
    return { id: row.id, verdict: inside ? "accepted-rasterization-only" : "envelope-violation" };
  });
  return { pass: verdicts.length > 0 && verdicts.every((row) => row.verdict === "accepted-rasterization-only"), rows: verdicts };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name: string): string => { const i = process.argv.indexOf(name); if (i < 0 || process.argv[i + 1] == null) throw new Error(`missing ${name}`); return process.argv[i + 1]; };
  const report = adjudicatePathsRasterRows(JSON.parse(readFileSync(arg("--rows"), "utf8")), JSON.parse(readFileSync(arg("--envelopes"), "utf8")));
  writeFileSync(arg("--out"), JSON.stringify({ schemaVersion: 1, ...report }, null, 2));
  console.log(`Paths/native raster gate: ${report.rows.length} rows; ${report.pass ? "PASS" : "WITHHELD"}`);
  if (!report.pass) process.exitCode = 1;
}
