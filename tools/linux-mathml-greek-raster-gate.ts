#!/usr/bin/env tsx
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

import {
  FREE_SANS_NOBLE_PACKAGE,
  LINUX_MATHML_GREEK_CELL,
  LINUX_MATHML_GREEK_SUBSETS,
  LINUX_MATHML_GREEK_TOKENS,
  assertLinuxMathmlGreekPreterminalEvidence,
  linuxMathmlGreekCellSha256,
  linuxMathmlGreekPreterminalSchema,
} from "./linux-mathml-greek-raster-contract.js";
import { decodePathsRasterPng, measureDecodedPathsRasterResidual } from "./paths-native-raster-metrics.js";

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const finite = z.number().finite();
const glyphSchema = z.object({
  gid: z.number().int().positive(), cluster: z.number().int().nonnegative(),
  advanceX: finite, advanceY: finite, offsetX: finite, offsetY: finite,
  outlineSha256: sha, outlineCommandCount: z.number().int().positive(),
}).strict();
const matrixSchema = z.tuple([finite, finite, finite, finite, finite, finite]);
const artifactSchema = z.object({
  path: z.string().min(1), sha256: sha, width: z.number().int().positive(), height: z.number().int().positive(),
}).strict();
const inkSchema = z.object({
  area: z.number().int().nonnegative(), x: z.number().int().nonnegative(), y: z.number().int().nonnegative(),
  width: z.number().int().nonnegative(), height: z.number().int().nonnegative(),
}).strict();
const residualSchema = z.object({
  changedPixels: z.number().int().nonnegative(), area: z.number().int().nonnegative(),
  width: z.number().int().nonnegative(), height: z.number().int().nonnegative(),
  maxEdgeDistance: finite.nonnegative(), severity: finite.nonnegative(), totalChannelDelta: z.number().int().nonnegative(),
  nativeInk: inkSchema, pathsInk: inkSchema,
}).strict();

const logicalTokenSchema = z.object({
  id: z.enum(["alpha", "beta", "pi", "theta"]),
  glyph: glyphSchema,
  baseline: finite,
  matrix: matrixSchema,
}).strict();

const fingerprintSchema = z.object({
  platform: z.literal("linux"), osImage: z.string().min(1), osImageVersion: z.string().min(1),
  arch: z.string().min(1), osRelease: z.string().min(1),
  chromium: z.string().min(1), chromiumRevision: z.string().min(1), browserExecutableSha256: sha,
  fontconfigVersion: z.string().min(1), fontconfigConfigSha256: sha, fontInventorySha256: sha,
  rendererSourceSha256: sha, oracleSourceSha256: sha,
  consumerRasterizer: z.string().min(1), playwrightVersion: z.string().min(1),
  nodeVersion: z.string().min(1), icuVersion: z.string().min(1), sharpVersion: z.string().min(1),
  libvipsVersion: z.string().min(1), metricAlgorithm: z.literal(LINUX_MATHML_GREEK_CELL.metricAlgorithm),
  launchFlags: z.array(z.string()), locale: z.string().min(1),
}).strict();

export const linuxMathmlGreekRasterRowSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.literal(LINUX_MATHML_GREEK_CELL.id),
  runLabel: z.enum(["proposal", "validation"]),
  runProvenance: z.object({
    githubRunId: z.string().min(1), githubRunAttempt: z.string().min(1), githubJob: z.string().min(1),
    runnerName: z.string().min(1), runnerBootIdSha256: sha, workflowRef: z.string().min(1),
  }).strict(),
  cellSha256: z.literal(linuxMathmlGreekCellSha256()),
  fingerprint: fingerprintSchema,
  preterminal: linuxMathmlGreekPreterminalSchema,
  pathsLogical: z.object({
    sourceSha256: z.literal(FREE_SANS_NOBLE_PACKAGE.fontSha256),
    faceIndex: z.literal(0),
    postscriptName: z.literal("FreeSans"),
    subsetHintedSha256: z.literal(LINUX_MATHML_GREEK_SUBSETS.hinted.sha256),
    subsetUnhintedSha256: z.literal(LINUX_MATHML_GREEK_SUBSETS.unhinted.sha256),
    tokens: z.array(logicalTokenSchema).length(LINUX_MATHML_GREEK_TOKENS.length),
  }).strict(),
  hintingControl: z.object({
    requestedFamily: z.string().min(1), computedFamily: z.string().min(1),
    fontFaceRuleFamily: z.string().min(1), fontFaceRuleCount: z.literal(1),
    sourceSha256: z.literal(LINUX_MATHML_GREEK_SUBSETS.unhinted.sha256),
    sourceByteLength: z.literal(LINUX_MATHML_GREEK_SUBSETS.unhinted.byteLength),
    isCustomFont: z.literal(true), glyphCount: z.literal(LINUX_MATHML_GREEK_TOKENS.length),
    tokens: z.array(logicalTokenSchema).length(LINUX_MATHML_GREEK_TOKENS.length),
  }).strict(),
  nativeArtifact: artifactSchema,
  pathsArtifact: artifactSchema,
  hintingOffArtifact: artifactSchema,
  residual: residualSchema,
  hintingOffResidual: residualSchema,
  warnings: z.array(z.string()),
}).strict();

export type LinuxMathmlGreekRasterRow = z.infer<typeof linuxMathmlGreekRasterRowSchema>;
export type LinuxMathmlGreekResidual = z.infer<typeof residualSchema>;

const maximaSchema = residualSchema.pick({
  changedPixels: true, area: true, width: true, height: true,
  maxEdgeDistance: true, severity: true, totalChannelDelta: true,
});
const roleHashesSchema = z.object({ native: sha, paths: sha, hintingOff: sha }).strict();
export const linuxMathmlGreekEnvelopeFileSchema = z.object({
  schemaVersion: z.literal(1),
  entries: z.array(z.object({
    cellSha256: z.literal(linuxMathmlGreekCellSha256()), fingerprintSha256: sha,
    proposalHashes: roleHashesSchema, validationHashes: roleHashesSchema,
    maxima: maximaSchema,
    reviewer: z.string().min(1), reviewedAt: z.string().datetime(),
  }).strict()),
}).strict();
export type LinuxMathmlGreekEnvelopeFile = z.infer<typeof linuxMathmlGreekEnvelopeFileSchema>;

const canonicalValue = (value: unknown): unknown => Array.isArray(value) ? value.map(canonicalValue)
  : value != null && typeof value === "object"
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonicalValue(entry)]))
    : value;
const canonical = (value: unknown): string => JSON.stringify(canonicalValue(value));
const sha256 = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");
export const linuxMathmlGreekFingerprintSha256 = (fingerprint: LinuxMathmlGreekRasterRow["fingerprint"]): string => sha256(canonical(fingerprint));

function logicalProblems(row: LinuxMathmlGreekRasterRow): string[] {
  const problems = [...row.warnings];
  try { assertLinuxMathmlGreekPreterminalEvidence(row.preterminal); } catch (error) { problems.push(String(error)); }
  if (row.preterminal.inventory.inventorySha256 !== row.fingerprint.fontInventorySha256) problems.push("pre-terminal/fingerprint font inventory mismatch");
  if (row.preterminal.inventory.configSha256 !== row.fingerprint.fontconfigConfigSha256) problems.push("pre-terminal/fingerprint Fontconfig configuration mismatch");
  for (let index = 0; index < LINUX_MATHML_GREEK_TOKENS.length; index++) {
    const expected = LINUX_MATHML_GREEK_TOKENS[index];
    const source = row.preterminal.tokens[index];
    const paths = row.pathsLogical.tokens[index];
    const hinting = row.hintingControl.tokens[index];
    if (paths.id !== expected.id || JSON.stringify(paths.glyph) !== JSON.stringify(expected.glyph)) problems.push(`${expected.id}: paths glyph does not match the authenticated source`);
    if (hinting.id !== expected.id || JSON.stringify(hinting.glyph) !== JSON.stringify(expected.glyph)) problems.push(`${expected.id}: hinting-off glyph does not match the authenticated source`);
    if (paths.baseline !== source.geometry.baseline || canonical(paths.matrix) !== canonical(source.geometry.matrix)) problems.push(`${expected.id}: paths placement is not capture-owned`);
    if (hinting.baseline !== source.geometry.baseline || canonical(hinting.matrix) !== canonical(source.geometry.matrix)) problems.push(`${expected.id}: hinting-off placement is not capture-owned`);
  }
  if (row.hintingControl.requestedFamily !== row.hintingControl.computedFamily
    || row.hintingControl.requestedFamily !== row.hintingControl.fontFaceRuleFamily) problems.push("hinting-off custom-face family ownership mismatch");
  if (row.nativeArtifact.sha256 === row.pathsArtifact.sha256) problems.push("native/paths raster arms are inert");
  if (row.nativeArtifact.sha256 === row.hintingOffArtifact.sha256) problems.push("hinting-off negative control is inert");
  if (row.hintingOffResidual.changedPixels === 0 || row.hintingOffResidual.totalChannelDelta === 0) problems.push("hinting-off negative control reports no movement");
  return problems;
}

function safeArtifact(root: string, path: string): string {
  const base = resolve(root), absolute = resolve(base, path);
  const rel = relative(base, absolute).replaceAll("\\", "/");
  if (rel === "" || rel.startsWith("../") || rel.includes("/../")) throw new Error(`artifact path escapes bundle: ${path}`);
  return absolute;
}

/** Reopen every lossless artifact and distrust caller-supplied hashes/metrics. */
export async function reauthenticateLinuxMathmlGreekRows(raw: unknown, artifactRoot: string): Promise<LinuxMathmlGreekRasterRow[]> {
  const parsed = z.array(linuxMathmlGreekRasterRowSchema).parse(raw);
  const seenPaths = new Set<string>();
  const rows: LinuxMathmlGreekRasterRow[] = [];
  for (const row of parsed) {
    const artifacts = [row.nativeArtifact, row.pathsArtifact, row.hintingOffArtifact];
    const bytes: Buffer[] = [];
    for (const artifact of artifacts) {
      const absolute = safeArtifact(artifactRoot, artifact.path);
      if (seenPaths.has(absolute)) throw new Error(`${row.id}: artifact path reused: ${artifact.path}`);
      seenPaths.add(absolute);
      const content = readFileSync(absolute);
      const decoded = await decodePathsRasterPng(content);
      if (decoded.width !== artifact.width || decoded.height !== artifact.height) throw new Error(`${row.id}: ${artifact.path} dimensions are unauthenticated`);
      if (sha256(content) !== artifact.sha256) throw new Error(`${row.id}: ${artifact.path} SHA-256 is unauthenticated`);
      bytes.push(content);
    }
    const [native, paths, hintingOff] = await Promise.all(bytes.map(decodePathsRasterPng));
    const residual = measureDecodedPathsRasterResidual(native, paths);
    const hintingOffResidual = measureDecodedPathsRasterResidual(native, hintingOff);
    if (canonical(residual) !== canonical(row.residual)) throw new Error(`${row.id}: native/paths residual is unauthenticated`);
    if (canonical(hintingOffResidual) !== canonical(row.hintingOffResidual)) throw new Error(`${row.id}: hinting-off residual is unauthenticated`);
    const problems = logicalProblems(row);
    if (problems.length > 0) throw new Error(`${row.id}: ${problems.join("; ")}`);
    rows.push(row);
  }
  return rows;
}

function maxima(residual: LinuxMathmlGreekResidual): z.infer<typeof maximaSchema> {
  return {
    changedPixels: residual.changedPixels, area: residual.area, width: residual.width, height: residual.height,
    maxEdgeDistance: residual.maxEdgeDistance, severity: residual.severity, totalChannelDelta: residual.totalChannelDelta,
  };
}

function inside(actual: z.infer<typeof maximaSchema>, limit: z.infer<typeof maximaSchema>): boolean {
  return (Object.keys(limit) as Array<keyof typeof limit>).every((key) => actual[key] <= limit[key]);
}

export interface LinuxMathmlGreekReport {
  schemaVersion: 1;
  pass: boolean;
  eligibleForRatification: boolean;
  verdict: "logical-mismatch" | "incomplete-independent-evidence" | "logical-exact-unratified" | "ratified-rasterization-only" | "validation-exceeds-proposal";
  problems: string[];
  candidateEnvelope?: Omit<LinuxMathmlGreekEnvelopeFile["entries"][number], "reviewer" | "reviewedAt">;
}

export function adjudicateLinuxMathmlGreekRows(
  rawRows: unknown,
  rawEnvelopes: unknown,
): LinuxMathmlGreekReport {
  const parsed = z.array(linuxMathmlGreekRasterRowSchema).safeParse(rawRows);
  const envelopes = linuxMathmlGreekEnvelopeFileSchema.safeParse(rawEnvelopes);
  if (!parsed.success || !envelopes.success) return { schemaVersion: 1, pass: false, eligibleForRatification: false, verdict: "logical-mismatch", problems: [parsed.success ? envelopes.error.message : parsed.error.message] };
  const rows = parsed.data;
  const problems = rows.flatMap((row) => logicalProblems(row).map((problem) => `${row.runLabel}: ${problem}`));
  if (problems.length > 0) return { schemaVersion: 1, pass: false, eligibleForRatification: false, verdict: "logical-mismatch", problems };
  const proposal = rows.filter((row) => row.runLabel === "proposal");
  const validation = rows.filter((row) => row.runLabel === "validation");
  if (proposal.length !== 1 || validation.length !== 1) return { schemaVersion: 1, pass: false, eligibleForRatification: false, verdict: "incomplete-independent-evidence", problems: [`expected one proposal and one validation row, found ${proposal.length}/${validation.length}`] };
  const p = proposal[0], v = validation[0];
  if (canonical(p.fingerprint) !== canonical(v.fingerprint)) problems.push("proposal/validation fingerprints differ");
  if (p.runProvenance.runnerBootIdSha256 === v.runProvenance.runnerBootIdSha256) problems.push("proposal/validation were not collected on independent Linux machines");
  if (p.cellSha256 !== v.cellSha256) problems.push("proposal/validation cell identities differ");
  const proposalMaxima = maxima(p.residual), validationResidual = maxima(v.residual);
  const candidateEnvelope = {
    cellSha256: p.cellSha256,
    fingerprintSha256: linuxMathmlGreekFingerprintSha256(p.fingerprint),
    proposalHashes: { native: p.nativeArtifact.sha256, paths: p.pathsArtifact.sha256, hintingOff: p.hintingOffArtifact.sha256 },
    validationHashes: { native: v.nativeArtifact.sha256, paths: v.pathsArtifact.sha256, hintingOff: v.hintingOffArtifact.sha256 },
    maxima: proposalMaxima,
  };
  if (!inside(validationResidual, proposalMaxima)) problems.push("independent validation exceeds the proposal residual in at least one scalar dimension");
  if (problems.length > 0) return { schemaVersion: 1, pass: false, eligibleForRatification: false, verdict: problems.some((problem) => problem.includes("exceeds")) ? "validation-exceeds-proposal" : "incomplete-independent-evidence", problems, candidateEnvelope };
  const envelope = envelopes.data.entries.find((entry) => entry.cellSha256 === candidateEnvelope.cellSha256 && entry.fingerprintSha256 === candidateEnvelope.fingerprintSha256);
  if (envelope == null) return { schemaVersion: 1, pass: false, eligibleForRatification: true, verdict: "logical-exact-unratified", problems: [], candidateEnvelope };
  if (canonical(envelope.proposalHashes) !== canonical(candidateEnvelope.proposalHashes)
    || canonical(envelope.validationHashes) !== canonical(candidateEnvelope.validationHashes)
    || canonical(envelope.maxima) !== canonical(candidateEnvelope.maxima)) {
    return { schemaVersion: 1, pass: false, eligibleForRatification: false, verdict: "logical-mismatch", problems: ["ratified envelope is not the reviewed proposal/validation evidence"], candidateEnvelope };
  }
  return { schemaVersion: 1, pass: true, eligibleForRatification: true, verdict: "ratified-rasterization-only", problems: [], candidateEnvelope };
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode === "produce") {
    const observations = arg("--observations"), out = arg("--out");
    if (observations == null || out == null) throw new Error("usage: linux-mathml-greek-raster-gate produce --observations <json> --out <json>");
    const rows = await reauthenticateLinuxMathmlGreekRows(JSON.parse(readFileSync(observations, "utf8")), dirname(resolve(observations)));
    writeFileSync(out, JSON.stringify(rows, null, 2));
    console.log(`Authenticated ${rows.length} Linux MathML Greek raster row(s).`);
    return;
  }
  if (mode === "aggregate") {
    const artifacts = arg("--artifacts"), envelopePath = arg("--envelopes"), out = arg("--out");
    if (artifacts == null || envelopePath == null || out == null) throw new Error("usage: linux-mathml-greek-raster-gate aggregate --artifacts <dir> --envelopes <json> --out <json> [--allow-unratified]");
    const root = resolve(artifacts);
    const files = readdirSync(root, { recursive: true }).map(String).filter((file) => file.endsWith("linux-mathml-greek-raster-rows.json"));
    const rows: LinuxMathmlGreekRasterRow[] = [];
    for (const file of files) {
      const absolute = resolve(root, file);
      rows.push(...await reauthenticateLinuxMathmlGreekRows(JSON.parse(readFileSync(absolute, "utf8")), dirname(absolute)));
    }
    const report = adjudicateLinuxMathmlGreekRows(rows, JSON.parse(readFileSync(envelopePath, "utf8")));
    writeFileSync(out, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (!report.pass && !(process.argv.includes("--allow-unratified") && report.eligibleForRatification)) process.exitCode = 1;
    return;
  }
  throw new Error("usage: linux-mathml-greek-raster-gate <produce|aggregate> ...");
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
