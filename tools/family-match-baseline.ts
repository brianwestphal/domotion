/**
 * Env-keyed baseline sets for the family-match conformance oracles
 * (docs 110 / 111).
 *
 * A family-match baseline records machine-dependent counts plus an
 * environment fingerprint, and the comparators refuse to judge across a
 * fingerprint change — a difference measured across two environments is not
 * evidence about the code. That policy meant one baseline file could serve
 * exactly one environment, while the oracles legitimately run in several
 * (the arm64 Docker-on-Apple-Silicon noble image and CI's x64 ubuntu
 * container; the arm64 Parallels Windows 11 VM and CI's x64 windows-latest
 * runner). This module lets one committed file carry ONE baseline PER
 * environment, selected by fingerprint equality:
 *
 *   { "format": "family-match-baseline-set/1", "baselines": [ <report>, … ] }
 *
 * A legacy file containing a single bare report (the pre-set shape) reads as
 * a one-entry set, so committed baselines need no migration; the first
 * `--write-baseline` on a second environment rewrites the file in set form,
 * preserving the existing entries byte-for-byte as JSON values.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export interface FamilyMatchMiss { family: string; css: number; chrome: string; ours: string }

export interface FamilyMatchReport {
  meta: {
    suite: string;
    os: string;
    capturedAt: string;
    env: Record<string, string | number>;
    weights: readonly number[];
  };
  summary: Record<string, number>;
  misses: FamilyMatchMiss[];
}

interface BaselineSetFile {
  format: "family-match-baseline-set/1";
  baselines: FamilyMatchReport[];
}

/** All recorded baselines in the file — [] when the file does not exist. */
export function readBaselineSet(file: string): FamilyMatchReport[] {
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, "utf8")) as FamilyMatchReport | BaselineSetFile;
  if ("baselines" in parsed && Array.isArray(parsed.baselines)) return parsed.baselines;
  return [parsed as FamilyMatchReport];
}

/** True when every fingerprint key agrees between the two environments. */
function envMatches(
  a: Record<string, unknown>, b: Record<string, unknown>, keys: readonly string[],
): boolean {
  return keys.every((k) => a[k] === b[k]);
}

/**
 * The recorded baseline whose fingerprint matches this run's environment, or
 * null — the caller's refuse-to-judge (exit 3) case.
 */
export function selectBaseline(
  entries: readonly FamilyMatchReport[],
  env: Record<string, string | number>,
  keys: readonly string[],
): FamilyMatchReport | null {
  return entries.find((e) => envMatches(e.meta.env, env, keys)) ?? null;
}

/** One line per recorded environment, for the refuse-to-judge message. */
export function describeRecordedEnvs(
  entries: readonly FamilyMatchReport[], keys: readonly string[],
): string[] {
  return entries.map((e) => keys.map((k) => `${k}=${String(e.meta.env[k])}`).join(" "));
}

/**
 * Record `report` for its environment: replaces the entry whose fingerprint
 * matches, appends otherwise. Always writes the set form.
 */
export function writeBaselineSet(
  file: string, report: FamilyMatchReport, keys: readonly string[],
): { replaced: boolean; total: number } {
  const entries = readBaselineSet(file);
  const idx = entries.findIndex((e) => envMatches(e.meta.env, report.meta.env, keys));
  const replaced = idx >= 0;
  if (replaced) entries[idx] = report;
  else entries.push(report);
  const out: BaselineSetFile = { format: "family-match-baseline-set/1", baselines: entries };
  writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  return { replaced, total: entries.length };
}
