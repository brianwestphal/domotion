import { createHash } from "node:crypto";
import { z } from "zod";

export const SCROLLBAR_GATE_SOURCE_REVISIONS = { chromium: "7d859f271cbda744098ac69f44978d4edfa62be3", skiaPinnedByChromium: "62efacd37737505732dbe3d8daa62abd679626a1" } as const;
export const SCROLLBAR_GATE_PLATFORMS = ["darwin", "linux", "win32"] as const;
export const SCROLLBAR_GATE_DPRS = [1, 2] as const;
export const SCROLLBAR_GATE_ZOOMS = [1, 1.25, 2] as const;
export const SCROLLBAR_GATE_SCENARIOS = ["overflow-visible-negative", "overflow-hidden-negative", "overflow-clip-negative", "auto-no-overflow-negative", "width-none-scrolled", "custom-scroll-no-overflow", "custom-y-top", "custom-y-mid", "custom-y-max", "custom-x-mid", "custom-both-corner", "custom-rtl-logical-left", "custom-vertical-writing", "custom-border-clip", "custom-zoom-125", "custom-resizer-overlap", "native-auto-light", "native-auto-dark", "native-thin-colors", "native-stable-both-edges"] as const;

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const artifactSchema = z.object({ role: z.enum(["source", "generated"]), path: z.string().min(1), sha256: sha, pngWidth: z.number().int().positive(), pngHeight: z.number().int().positive() });
const rowSchema = z.object({ id: z.enum(SCROLLBAR_GATE_SCENARIOS), axis: z.string().min(1), expectedRoute: z.enum(["marker-free-control", "custom-vector", "suppressed-captured-absence", "native-raster"]), deviceScaleFactor: z.union([z.literal(1), z.literal(2)]), cssZoom: z.union([z.literal(1), z.literal(1.25), z.literal(2)]), captured: z.object({ missingFacts: z.array(z.string()) }).passthrough().nullable(), warnings: z.array(z.string()), pass: z.literal(true), artifacts: z.array(artifactSchema) }).passthrough();
export const nativeScrollbarAuditReportSchema = z.object({
  schemaVersion: z.literal(2), evidenceRole: z.enum(["proposal", "validation"]), observationId: z.string().uuid(),
  provenance: z.object({ githubRunId: z.string().min(1), githubRunAttempt: z.string().min(1), githubJob: z.string().min(1), runnerName: z.string().min(1), runnerImage: z.string().min(1), runnerImageVersion: z.string().min(1), workflowRef: z.string().min(1), bootId: z.string().min(1) }),
  logicalRowsSha256: sha, rowSetSha256: sha, artifactSetSha256: sha,
  dynamicFadeClassification: z.literal("separate-platform-terminal-not-observed"),
  browserLaunch: z.object({ headless: z.literal(true), ignoredDefaultArguments: z.tuple([z.literal("--hide-scrollbars")]) }),
  chromiumExecutableSha256: sha,
  sourceRevisions: z.object({ chromium: z.string(), skiaPinnedByChromium: z.string() }),
  host: z.object({ platform: z.enum(SCROLLBAR_GATE_PLATFORMS), architecture: z.string().min(1), release: z.string().min(1) }),
  chromiumVersion: z.string().min(1), playwrightVersion: z.string().min(1), rows: z.array(rowSchema),
  controls: z.record(z.string(), z.boolean()), mutations: z.record(z.string(), z.boolean()),
  platformFingerprints: z.array(z.unknown()), verdict: z.literal("authoritative-capture-and-source-owned-paint-exact"),
}).strict();
export type NativeScrollbarAuditReport = z.infer<typeof nativeScrollbarAuditReportSchema>;
export type NativeScrollbarAuditRow = NativeScrollbarAuditReport["rows"][number];
export interface NativeScrollbarRasterEnvelope { id: string; reviewed: true }
export interface NativeScrollbarGateResult { ready: boolean; blockers: string[]; summary: string }

const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const rowKey = (row: NativeScrollbarAuditRow): string => `${row.id}@${row.deviceScaleFactor}x/z${row.cssZoom}`;
const artifactManifest = (report: NativeScrollbarAuditReport) => report.rows.flatMap((row) => row.artifacts.map((artifact) => ({ row: rowKey(row), ...artifact })));
const logicalRows = (report: NativeScrollbarAuditReport) => report.rows.map((row) => ({ id: row.id, axis: row.axis, expectedRoute: row.expectedRoute, deviceScaleFactor: row.deviceScaleFactor, cssZoom: row.cssZoom, captured: row.captured }));

export function adjudicateNativeScrollbarReports(inputs: readonly unknown[], _envelopes: readonly NativeScrollbarRasterEnvelope[] = [], artifactIntegrityBlockers: readonly string[] = []): NativeScrollbarGateResult {
  const blockers = [...artifactIntegrityBlockers];
  const reports: Array<{ parsed: NativeScrollbarAuditReport; raw: NativeScrollbarAuditReport }> = [];
  inputs.forEach((input, index) => {
    const parsed = nativeScrollbarAuditReportSchema.safeParse(input);
    if (!parsed.success) blockers.push(`report ${index + 1}: schema v2 rejected evidence: ${z.prettifyError(parsed.error)}`);
    else reports.push({ parsed: parsed.data, raw: input as NativeScrollbarAuditReport });
  });
  const byRole = new Map<string, NativeScrollbarAuditReport>();
  for (const { parsed: report, raw } of reports) {
    const key = `${report.host.platform}/${report.evidenceRole}`;
    if (byRole.has(key)) blockers.push(`duplicate role-bound report: ${key}`);
    byRole.set(key, report);
    if (report.sourceRevisions.chromium !== SCROLLBAR_GATE_SOURCE_REVISIONS.chromium || report.sourceRevisions.skiaPinnedByChromium !== SCROLLBAR_GATE_SOURCE_REVISIONS.skiaPinnedByChromium) blockers.push(`${key}: source revision mismatch`);
    // Zod deliberately reconstructs objects in schema-key order. The producer
    // digests the serialized report objects before writing them, so authenticate
    // the validated raw representation rather than a key-reordered parse copy.
    if (report.rowSetSha256 !== digest(raw.rows)) blockers.push(`${key}: canonical row-set hash mismatch`);
    if (report.logicalRowsSha256 !== digest(logicalRows(raw))) blockers.push(`${key}: canonical logical-row hash mismatch`);
    if (report.artifactSetSha256 !== digest(artifactManifest(raw))) blockers.push(`${key}: canonical artifact-set hash mismatch`);
    if (!Object.values(report.controls).every(Boolean)) blockers.push(`${key}: ownership controls are not all active`);
    if (!Object.values(report.mutations).every(Boolean)) blockers.push(`${key}: destructive mutations are not all active`);
    const rows = new Map<string, NativeScrollbarAuditRow>();
    for (const row of report.rows) {
      const rk = rowKey(row);
      if (rows.has(rk)) blockers.push(`${key}: duplicate row ${rk}`);
      rows.set(rk, row);
      if (row.warnings.length > 0) blockers.push(`${key}/${rk}: warnings are forbidden`);
      if (row.captured == null || row.captured.missingFacts.length > 0) blockers.push(`${key}/${rk}: source ownership facts incomplete`);
      if (row.artifacts.length !== 2 || new Set(row.artifacts.map((artifact) => artifact.role)).size !== 2) blockers.push(`${key}/${rk}: lossless source/generated artifact pair incomplete`);
    }
    for (const id of SCROLLBAR_GATE_SCENARIOS) for (const dpr of SCROLLBAR_GATE_DPRS) for (const zoom of SCROLLBAR_GATE_ZOOMS) {
      const rk = `${id}@${dpr}x/z${zoom}`;
      if (!rows.has(rk)) blockers.push(`${key}: missing Cartesian row ${rk}`);
    }
  }
  for (const platform of SCROLLBAR_GATE_PLATFORMS) for (const role of ["proposal", "validation"] as const) if (!byRole.has(`${platform}/${role}`)) blockers.push(`missing role-bound report: ${platform}/${role}`);
  for (const platform of SCROLLBAR_GATE_PLATFORMS) {
    const proposal = byRole.get(`${platform}/proposal`); const validation = byRole.get(`${platform}/validation`);
    if (proposal == null || validation == null) continue;
    if (proposal.observationId === validation.observationId) blockers.push(`${platform}: proposal/validation observation ids are not independent`);
    if (proposal.provenance.bootId === validation.provenance.bootId) blockers.push(`${platform}: proposal/validation boot ids are not independent`);
    if (proposal.provenance.githubRunId !== validation.provenance.githubRunId || proposal.provenance.githubRunAttempt !== validation.provenance.githubRunAttempt || proposal.provenance.workflowRef !== validation.provenance.workflowRef) blockers.push(`${platform}: proposal/validation workflow provenance differs`);
    // Hosted image patch revisions can roll between independent matrix jobs in
    // one workflow (and macOS can cross a point release). Require the stable
    // execution identity instead: image family, architecture, exact browser
    // binary, and Playwright. The volatile image/version/release values remain
    // retained provenance, while exact logical-row agreement proves the
    // platform transition did not change scrollbar ownership.
    if (proposal.provenance.runnerImage !== validation.provenance.runnerImage
      || proposal.host.architecture !== validation.host.architecture
      || proposal.chromiumVersion !== validation.chromiumVersion
      || proposal.chromiumExecutableSha256 !== validation.chromiumExecutableSha256
      || proposal.playwrightVersion !== validation.playwrightVersion) {
      blockers.push(`${platform}: proposal/validation stable environment identities differ`);
    }
    if (proposal.logicalRowsSha256 !== validation.logicalRowsSha256) blockers.push(`${platform}: proposal/validation logical rows disagree`);
  }
  const unique = [...new Set(blockers)];
  return { ready: unique.length === 0, blockers: unique, summary: `${unique.length === 0 ? "READY" : "NOT READY"}: ${unique.length} native scrollbar blocker(s)` };
}
