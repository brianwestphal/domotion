import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { loadActivationLedger, validateActivationLedger } from "./activation-coverage.js";
import { loadSemanticCoverage, validateSemanticCoverage } from "./semantic-coverage.js";

export const RELEASE_SUITES = ["features", "showcase", "html", "unicode", "real-world"] as const;
export const RESIDUAL_CLASSES = ["logical", "paint-compositing", "unsupported", "rasterization-only"] as const;
const evidenceSchema = z.object({
  schemaVersion: z.literal(1), sourceRevision: z.string().min(7),
  stageOracles: z.array(z.object({ id: z.string(), report: z.string(), passed: z.boolean(), sourceRevision: z.string() })),
  platforms: z.array(z.object({
    platform: z.enum(["darwin", "linux", "win32"]), environmentFingerprint: z.string().min(1),
    comparableGroup: z.string().min(1), reviewedAt: z.string().datetime(), suites: z.array(z.enum(RELEASE_SUITES)),
    residuals: z.array(z.object({ fixture: z.string(), classification: z.enum(RESIDUAL_CLASSES), explained: z.boolean(), reason: z.string().min(1) })),
  })),
  relaxedThresholds: z.array(z.object({ id: z.string(), justified: z.boolean(), sourceEvidence: z.string().min(1) })),
  unsupportedBoundaries: z.array(z.object({ id: z.string(), reason: z.string().min(1) })),
});
export type ParityReleaseEvidence = z.infer<typeof evidenceSchema>;
export interface ParityReleaseResult { ready: boolean; blockers: string[]; unsupported: string[]; summary: string }

export async function loadParityReleaseEvidence(path: string): Promise<ParityReleaseEvidence> {
  const parsed = evidenceSchema.safeParse(JSON.parse(await readFile(path, "utf8")) as unknown);
  if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
  return parsed.data;
}

export async function evaluateParityRelease(root: string, evidence: ParityReleaseEvidence): Promise<ParityReleaseResult> {
  const blockers: string[] = [];
  const semantic = await loadSemanticCoverage(resolve(root, "tools/semantic-coverage.json"));
  const semanticValidation = await validateSemanticCoverage(semantic, root);
  blockers.push(...semanticValidation.errors.map((error) => `semantic inventory: ${error}`));
  for (const row of semantic.transitions) if (row.coverage === "partial") blockers.push(`partial semantic family: ${row.id}`);
  const unsupported = semantic.transitions.filter((row) => row.coverage === "unsupported").map((row) => `${row.id}: ${row.boundary ?? "missing boundary"}`);

  const activation = await loadActivationLedger(resolve(root, "tools/activation-coverage.json"));
  blockers.push(...(await validateActivationLedger(activation, root)).map((error) => `activation ledger: ${error}`));

  const parity = JSON.parse(await readFile(resolve(root, "tools/parity-program.json"), "utf8")) as { areas: Array<{ id: string; sourceAudit: string; oracleStatus: string; platformCoverage: string[] }> };
  for (const area of parity.areas) {
    if (!new Set(["audited", "not-applicable"]).has(area.sourceAudit)) blockers.push(`source audit incomplete: ${area.id} (${area.sourceAudit})`);
    if (!new Set(["exact-stage-gate", "pixel-integration-gate"]).has(area.oracleStatus)) blockers.push(`stage gate not exact: ${area.id} (${area.oracleStatus})`);
    for (const platform of ["darwin", "linux", "win32"]) if (!area.platformCoverage.includes(platform)) blockers.push(`parity area ${area.id} lacks ${platform} evidence`);
  }

  const oracleById = new Map(evidence.stageOracles.map((oracle) => [oracle.id, oracle]));
  for (const area of parity.areas.filter((entry) => entry.oracleStatus !== "pixel-integration-gate")) {
    const oracle = oracleById.get(area.id);
    if (oracle == null) blockers.push(`missing stage-oracle report: ${area.id}`);
    else if (!oracle.passed) blockers.push(`stage-oracle report failed: ${area.id}`);
    else if (oracle.sourceRevision !== evidence.sourceRevision) blockers.push(`stage-oracle revision mismatch: ${area.id}`);
  }

  const platformMap = new Map(evidence.platforms.map((entry) => [entry.platform, entry]));
  for (const platform of ["darwin", "linux", "win32"] as const) {
    const run = platformMap.get(platform);
    if (run == null) { blockers.push(`missing reviewed visual evidence: ${platform}`); continue; }
    for (const suite of RELEASE_SUITES) if (!run.suites.includes(suite)) blockers.push(`${platform} visual evidence lacks ${suite}`);
    for (const residual of run.residuals) {
      if (!residual.explained) blockers.push(`unexplained residual: ${platform}/${residual.fixture}`);
      if (residual.classification === "logical") blockers.push(`logical residual remains: ${platform}/${residual.fixture}`);
    }
  }
  const comparisonGroups = new Set(evidence.platforms.map((entry) => entry.comparableGroup));
  if (evidence.platforms.length === 3 && comparisonGroups.size !== 1) blockers.push("platform environment fingerprints are not in one comparable group");
  for (const threshold of evidence.relaxedThresholds) if (!threshold.justified) blockers.push(`unjustified relaxed threshold: ${threshold.id}`);
  for (const boundary of evidence.unsupportedBoundaries) unsupported.push(`${boundary.id}: ${boundary.reason}`);

  const uniqueBlockers = [...new Set(blockers)];
  return { ready: uniqueBlockers.length === 0, blockers: uniqueBlockers, unsupported, summary: `${uniqueBlockers.length === 0 ? "READY" : "NOT READY"}: ${uniqueBlockers.length} blocker(s), ${unsupported.length} explicit unsupported boundary/boundaries` };
}
