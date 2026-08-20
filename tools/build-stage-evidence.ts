#!/usr/bin/env tsx
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import type { StageEvidenceManifest, StageEvidenceReport, StageEvidenceRule } from "../src/review/stage-evidence.js";
import type { SemanticCoverageInventory } from "./semantic-coverage.js";

interface ParityArea { id: string; oracle: string; }

const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

function fixtureRule(ref: string, transitionId: string, areas: string[]): StageEvidenceRule | null {
  const [path, fixture] = ref.split("#", 2);
  if (path === "tests/features.ts" && fixture != null) return { suites: ["features"], fixture, transitionIds: [transitionId], areas };
  if (path === "tests/html-test-suite.tsx") return { suites: ["html-test", "html-test-unicode"], transitionIds: [transitionId], areas };
  if (path === "tests/real-world.tsx") return { suites: ["real-world"], transitionIds: [transitionId], areas };
  return null;
}

function summarizeReport(area: ParityArea, reportsDir: string): StageEvidenceReport {
  const reportFile = `${area.id}.json`;
  const path = resolve(reportsDir, reportFile);
  if (!existsSync(path)) return { area: area.id, oracle: area.oracle, status: "missing", note: "No stage report was attached by this run." };
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as {
      rows?: Array<{ pass?: boolean }>; records?: unknown[]; failures?: unknown[];
      pass?: boolean; verdict?: string; mismatches?: number; pairs?: number; evidenceOracle?: string; evidencePassed?: boolean;
    };
    const rows = Array.isArray(value.rows) ? value.rows : undefined;
    const totalRows = rows?.length ?? value.records?.length ?? value.pairs;
    const passedRows = rows != null ? rows.filter((row) => row.pass === true).length
      : value.verdict === "exact-logical-agreement" && totalRows != null ? totalRows : undefined;
    const inferredPass = value.pass === true || value.verdict === "exact-logical-agreement" || value.verdict === "evidence-complete"
      || (totalRows != null && totalRows > 0 && passedRows === totalRows && (value.mismatches ?? 0) === 0)
      || (Array.isArray(value.failures) && value.failures.length === 0);
    const passed = value.evidencePassed ?? inferredPass;
    return { area: area.id, oracle: value.evidenceOracle ?? area.oracle, status: passed ? "passed" : "failed", passedRows, totalRows, reportFile };
  } catch (error) {
    return { area: area.id, oracle: area.oracle, status: "failed", reportFile, note: `Unreadable report: ${String(error)}` };
  }
}

export function buildStageEvidence(
  semantic: SemanticCoverageInventory,
  areas: ParityArea[],
  reportsDir: string,
  environment: Record<string, unknown>,
  sourceRevision: string,
): StageEvidenceManifest {
  const merged = new Map<string, StageEvidenceRule>();
  for (const transition of semantic.transitions) {
    for (const ref of transition.visualFixtures) {
      const rule = fixtureRule(ref, transition.id, transition.parityAreas);
      if (rule == null) continue;
      const key = `${rule.suites.join(",")}:${rule.fixture ?? "*"}`;
      const current = merged.get(key);
      if (current == null) merged.set(key, rule);
      else {
        current.transitionIds = [...new Set([...current.transitionIds, ...rule.transitionIds])].sort();
        current.areas = [...new Set([...current.areas, ...rule.areas])].sort();
      }
    }
  }
  const fingerprint = createHash("sha256").update(JSON.stringify(environment)).digest("hex");
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceRevision,
    platform: typeof environment.platform === "string" ? environment.platform : process.platform,
    environmentFingerprint: { ...environment, fingerprint },
    reports: areas.map((area) => summarizeReport(area, reportsDir)),
    rules: [...merged.values()],
  };
}

function main(): void {
  const out = resolve(arg("--out") ?? "stage-evidence.json");
  const reportsDir = resolve(arg("--reports") ?? dirname(out));
  const envPath = arg("--env");
  const semantic = JSON.parse(readFileSync(resolve("tools/semantic-coverage.json"), "utf8")) as SemanticCoverageInventory;
  const parity = JSON.parse(readFileSync(resolve("tools/parity-program.json"), "utf8")) as { areas: ParityArea[] };
  const environment = envPath != null && existsSync(envPath)
    ? JSON.parse(readFileSync(envPath, "utf8")) as Record<string, unknown>
    : { platform: process.platform, arch: process.arch };
  let revision = process.env.GITHUB_SHA ?? "unknown";
  if (revision === "unknown") {
    try { revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch { /* retain unknown */ }
  }
  writeFileSync(out, JSON.stringify(buildStageEvidence(semantic, parity.areas, reportsDir, environment, revision), null, 2) + "\n");
  console.log(`stage evidence: ${basename(out)}`);
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
