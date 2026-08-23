#!/usr/bin/env tsx
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { platform } from "node:os";
import { pathToFileURL } from "node:url";
import { parityEnvironment } from "./parity-environment.js";

export interface CorpusRun { text: string; fontFamily: string; [key: string]: unknown }
export interface RunCorpus { generatedAt: string; sources: string[]; splitWords?: boolean; runs: CorpusRun[] }
export type CorpusMode = "representative" | "exhaustive";
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value != null && typeof value === "object" ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) : value;
export const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
export const runIdentity = (run: CorpusRun): string => digest(run);

export function selectCorpusRuns(runs: CorpusRun[], mode: CorpusMode, shardIndex: number, shardCount: number, representativeLimit = 4096): CorpusRun[] {
  if (!Number.isInteger(shardIndex) || !Number.isInteger(shardCount) || shardCount < 1 || shardIndex < 0 || shardIndex >= shardCount) throw new Error("invalid shard i/n");
  const ordered = [...runs].sort((a, b) => runIdentity(a).localeCompare(runIdentity(b)));
  const population = mode === "representative" ? ordered.slice(0, representativeLimit) : ordered;
  return population.filter((run) => Number.parseInt(runIdentity(run).slice(0, 8), 16) % shardCount === shardIndex);
}

export function reduceMismatches(rows: Array<Record<string, unknown>>) {
  const groups = new Map<string, { signature: string; count: number; example: Record<string, unknown> }>();
  for (const row of rows) {
    const signature = [row.verdict, row.fontFamily, row.chromeGlyphs, row.ourGlyphs, row.maxDelta].join("|");
    const hit = groups.get(signature);
    if (hit == null) groups.set(signature, { signature, count: 1, example: row }); else hit.count++;
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.signature.localeCompare(b.signature));
}

const arg = (name: string, fallback?: string): string | undefined => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
async function main(): Promise<void> {
const runsFile = resolve(arg("--runs", "tests/output/shaping-unicode/full-runs.json")!);
const outDir = resolve(arg("--out", "tests/output/shaping-unicode")!);
const mode = arg("--mode", "representative") as CorpusMode;
const shard = (arg("--shard", "0/1")!).split("/").map(Number);
if (!existsSync(runsFile)) throw new Error(`missing corpus ${runsFile}; extract it with fonts:shaping:runs -- --source external/html-test/unicode`);
if (mode !== "representative" && mode !== "exhaustive") throw new Error(`invalid mode ${mode}`);
const corpus = JSON.parse(readFileSync(runsFile, "utf8")) as RunCorpus;
const selected = selectCorpusRuns(corpus.runs, mode, shard[0], shard[1], Number(arg("--representative-limit", "4096")));
const corpusDigest = digest({ sources: corpus.sources, splitWords: corpus.splitWords === true, runs: corpus.runs });
const shardDigest = digest({ corpusDigest, mode, shard, selected: selected.map(runIdentity) });
const shardDir = resolve(outDir, `${mode}-${shard[0]}-of-${shard[1]}`);
const manifestPath = resolve(shardDir, "manifest.json");
if (existsSync(manifestPath)) {
  const old = JSON.parse(readFileSync(manifestPath, "utf8")) as { shardDigest?: string; completed?: boolean; exitCode?: number };
  if (old.shardDigest === shardDigest && old.completed === true) { process.stdout.write(`resume hit ${manifestPath}\n`); process.exitCode = old.exitCode ?? 2; return; }
}
mkdirSync(shardDir, { recursive: true });
const shardCorpus = resolve(shardDir, "runs.json");
writeFileSync(shardCorpus, `${JSON.stringify({ ...corpus, runs: selected }, null, 2)}\n`);
const startedAt = new Date().toISOString();
const command = resolve("node_modules/.bin", platform() === "win32" ? "tsx.cmd" : "tsx");
const child = spawnSync(command, [resolve("tools/shaping-conformance.ts"), "--runs", shardCorpus, "--out", shardDir], { stdio: "inherit", shell: platform() === "win32" });
const reportPath = resolve(shardDir, "report.json");
const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, "utf8")) as { mismatches?: Array<Record<string, unknown>> } : null;
const reductions = reduceMismatches(report?.mismatches ?? []);
writeFileSync(resolve(shardDir, "mismatch-reductions.json"), `${JSON.stringify(reductions, null, 2)}\n`);
writeFileSync(manifestPath, `${JSON.stringify({
  schemaVersion: 1, mode, shard: { index: shard[0], count: shard[1] }, corpusDigest, shardDigest,
  selectedRuns: selected.length, totalRuns: corpus.runs.length, startedAt, completedAt: new Date().toISOString(),
  completed: child.status != null, exitCode: child.status, fingerprint: parityEnvironment({ chromium: String(report && (report as any).meta?.chromium || "unavailable"), launchFlags: [], deviceScaleFactor: 1, zoom: 1, writingMode: "mixed-corpus", direction: "mixed-corpus", corpusIdentity: corpusDigest, sampleIdentity: shardDigest }),
  report: "report.json", mismatchReductions: "mismatch-reductions.json",
}, null, 2)}\n`);
process.exitCode = child.status ?? 2;
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
