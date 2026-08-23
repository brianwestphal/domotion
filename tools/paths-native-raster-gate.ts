import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";

const finite = z.number().finite();
const fingerprintSchema = z.object({
  platform: z.enum(["darwin", "linux", "win32"]), osImage: z.string().min(1), arch: z.string().min(1),
  chromium: z.string().min(1), skia: z.string().min(1), harfbuzz: z.string().min(1),
  fontInventorySha256: z.string().regex(/^[a-f0-9]{64}$/), rendererRevision: z.string().min(1),
  consumerRasterizer: z.string().min(1), launchFlags: z.array(z.string()), locale: z.string().min(1),
}).strict();
const glyphSchema = z.object({ gid: z.number().int().nonnegative(), cluster: z.number().int().nonnegative(), advanceX: finite, advanceY: finite, offsetX: finite, offsetY: finite }).strict();
const logicalSchema = z.object({
  postscriptName: z.string().min(1), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/), faceIndex: z.number().int().nonnegative(),
  variationAxes: z.record(z.string(), finite), glyphs: z.array(glyphSchema).min(1), baseline: finite,
  matrix: z.tuple([finite, finite, finite, finite, finite, finite]),
}).strict();
const dimensionsSchema = z.object({
  fontTechnology: z.enum(["glyf-hinted", "glyf-unhinted", "cff", "cff2", "variable-glyf", "variable-cff2"]),
  fontSizePx: finite.positive(), weight: z.number().int().min(1).max(1000), phaseX: finite, phaseY: finite,
  transform: z.enum(["none", "translate", "scale", "rotate", "affine"]), deviceScaleFactor: z.union([z.literal(1), z.literal(2)]),
}).strict();
const residualSchema = z.object({ changedPixels: z.number().int().nonnegative(), area: z.number().int().nonnegative(), width: z.number().int().nonnegative(), height: z.number().int().nonnegative(), maxEdgeDistance: finite.nonnegative(), severity: finite.nonnegative() }).strict();
const artifactSchema = z.object({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/), width: z.number().int().positive(), height: z.number().int().positive() }).strict();
export const pathsRasterRowSchema = z.object({
  id: z.string().min(1), fingerprint: fingerprintSchema, dimensions: dimensionsSchema,
  expectedLogical: logicalSchema, actualLogical: logicalSchema, residual: residualSchema,
  nativeArtifact: artifactSchema, pathsArtifact: artifactSchema, warnings: z.array(z.string()),
}).strict();
export type PathsRasterRow = z.infer<typeof pathsRasterRowSchema>;

const envelopeSchema = z.object({
  key: z.string().min(1), fingerprintSha256: z.string().regex(/^[a-f0-9]{64}$/), dimensions: dimensionsSchema,
  max: residualSchema, reviewedArtifactSha256: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(2),
}).strict();
export const envelopeFileSchema = z.object({ schemaVersion: z.literal(1), ratified: z.boolean(), reviewer: z.string().min(1).optional(), reviewedAt: z.string().datetime().optional(), envelopes: z.array(envelopeSchema) }).strict().superRefine((file, ctx) => {
  if (file.ratified && (file.reviewer == null || file.reviewedAt == null)) ctx.addIssue({ code: "custom", message: "ratified envelopes require reviewer and reviewedAt" });
  for (let i = 0; i < file.envelopes.length; i++) if (file.envelopes[i].key !== dimensionsKey(file.envelopes[i].dimensions)) ctx.addIssue({ code: "custom", message: "envelope key does not match dimensions", path: ["envelopes", i, "key"] });
});

const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
  : value != null && typeof value === "object"
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, stable(entry)]))
    : value;
const canonical = (value: unknown): string => JSON.stringify(stable(value));
export const fingerprintSha256 = (fingerprint: PathsRasterRow["fingerprint"]): string => createHash("sha256").update(canonical(fingerprint)).digest("hex");
export const dimensionsKey = (dimensions: PathsRasterRow["dimensions"]): string => [dimensions.fontTechnology, dimensions.fontSizePx, dimensions.weight, dimensions.phaseX, dimensions.phaseY, dimensions.transform, dimensions.deviceScaleFactor].join("|");

function firstLogicalMismatch(expected: PathsRasterRow["expectedLogical"], actual: PathsRasterRow["actualLogical"]): string | null {
  if (expected.postscriptName !== actual.postscriptName || expected.sourceSha256 !== actual.sourceSha256 || expected.faceIndex !== actual.faceIndex || canonical(expected.variationAxes) !== canonical(actual.variationAxes)) return "face-instance";
  if (canonical(expected.glyphs) !== canonical(actual.glyphs)) return "gid-cluster-advance-offset";
  if (expected.baseline !== actual.baseline) return "baseline";
  if (canonical(expected.matrix) !== canonical(actual.matrix)) return "matrix";
  return null;
}

export interface PathsRasterVerdict { id: string; verdict: "logical-mismatch" | "invalid-evidence" | "envelope-unratified" | "missing-envelope" | "envelope-violation" | "accepted-rasterization-only"; reason?: string }

export function adjudicatePathsRasterRows(rawRows: unknown, rawEnvelopes: unknown): { pass: boolean; rows: PathsRasterVerdict[] } {
  const rows = z.array(pathsRasterRowSchema).parse(rawRows);
  const envelopeFile = envelopeFileSchema.parse(rawEnvelopes);
  const envelopes = new Map(envelopeFile.envelopes.map((entry) => [`${entry.fingerprintSha256}|${entry.key}`, entry]));
  const verdicts = rows.map((row): PathsRasterVerdict => {
    if (row.warnings.length > 0 || row.nativeArtifact.sha256 === row.pathsArtifact.sha256) return { id: row.id, verdict: "invalid-evidence", reason: row.warnings.length > 0 ? "warnings" : "inert-raster-arm" };
    const logical = firstLogicalMismatch(row.expectedLogical, row.actualLogical);
    if (logical != null) return { id: row.id, verdict: "logical-mismatch", reason: logical };
    if (!envelopeFile.ratified) return { id: row.id, verdict: "envelope-unratified" };
    const fingerprint = fingerprintSha256(row.fingerprint);
    const key = dimensionsKey(row.dimensions);
    const envelope = envelopes.get(`${fingerprint}|${key}`);
    if (envelope == null) return { id: row.id, verdict: "missing-envelope" };
    if (!envelope.reviewedArtifactSha256.includes(row.nativeArtifact.sha256) || !envelope.reviewedArtifactSha256.includes(row.pathsArtifact.sha256)) return { id: row.id, verdict: "missing-envelope", reason: "unreviewed-artifact" };
    const r = row.residual, m = envelope.max;
    const inside = r.changedPixels <= m.changedPixels && r.area <= m.area && r.width <= m.width && r.height <= m.height && r.maxEdgeDistance <= m.maxEdgeDistance && r.severity <= m.severity;
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
