#!/usr/bin/env tsx
/** Strict all-platform release gate for fragmented collapsed tables.
 *
 * Screen fragment ownership, public-print fail-closed ownership, and native
 * terminal ink are deliberately independent inputs. A green paint envelope
 * can never excuse an incomplete logical record.
 */
import { readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const FRAGMENTED_TABLE_PLATFORMS = ["darwin", "linux", "win32"] as const;
const SCREEN_DISCRIMINATORS = 21;
const SCREEN_MUTATIONS = 15;
const PAGED_MATRIX_CELLS = 8;
const PAGED_MUTATIONS = 15;
const FINAL_INK_ROWS = 1_152;

type JsonRecord = Record<string, unknown>;

export interface FragmentedTableReleaseResult {
  ready: boolean;
  blockers: string[];
  summary: string;
}

function record(value: unknown): JsonRecord | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord : null;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function platformOf(input: JsonRecord, kind: "screen" | "paged" | "ink"): string {
  if (kind === "ink") return String(input.platform ?? "");
  return String(record(input.environment)?.os ?? "");
}

function trueRecord(value: unknown): boolean {
  const row = record(value);
  return row != null && Object.values(row).every((entry) => entry === true || entry === false)
    && Object.entries(row).every(([key, entry]) => key === "pixelsRead" ? entry === false : entry === true);
}

export function adjudicateFragmentedCollapsedTableRelease(
  screenInputs: readonly unknown[],
  pagedInputs: readonly unknown[],
  inkInputs: readonly unknown[],
): FragmentedTableReleaseResult {
  const blockers: string[] = [];
  const screens = new Map<string, JsonRecord>();
  const paged = new Map<string, JsonRecord>();
  const ink = new Map<string, JsonRecord>();

  const ingest = (inputs: readonly unknown[], kind: "screen" | "paged" | "ink", target: Map<string, JsonRecord>) => {
    for (const input of inputs) {
      const row = record(input);
      if (row == null) {
        blockers.push(`${kind}: non-object report`);
        continue;
      }
      const platform = platformOf(row, kind);
      if (!FRAGMENTED_TABLE_PLATFORMS.includes(platform as typeof FRAGMENTED_TABLE_PLATFORMS[number])) {
        blockers.push(`${kind}: unsupported platform ${platform || "<missing>"}`);
        continue;
      }
      if (target.has(platform)) blockers.push(`${kind}: duplicate ${platform} report`);
      target.set(platform, row);
    }
  };
  ingest(screenInputs, "screen", screens);
  ingest(pagedInputs, "paged", paged);
  ingest(inkInputs, "ink", ink);

  for (const platform of FRAGMENTED_TABLE_PLATFORMS) {
    const screen = screens.get(platform);
    const print = paged.get(platform);
    const paint = ink.get(platform);
    if (screen == null) blockers.push(`screen: missing ${platform} report`);
    if (print == null) blockers.push(`paged: missing ${platform} report`);
    if (paint == null) blockers.push(`ink: missing ${platform} report`);

    if (screen != null) {
      const discriminators = record(screen.discriminators);
      const mutations = array(screen.mutations).map(record);
      if (screen.schemaVersion !== 3 || screen.pass !== true || screen.currentProtocolExact !== true
          || screen.verdict !== "screen-section-fragment-record-authenticated")
        blockers.push(`screen/${platform}: source-logical verdict is not exact`);
      if (discriminators == null || Object.keys(discriminators).length !== SCREEN_DISCRIMINATORS
          || !Object.values(discriminators).every(Boolean))
        blockers.push(`screen/${platform}: discriminator matrix incomplete`);
      if (mutations.length !== SCREEN_MUTATIONS || mutations.some((row) => row?.moved !== true))
        blockers.push(`screen/${platform}: destructive mutation matrix incomplete`);
      if (record(screen.print)?.pixelsRead !== false)
        blockers.push(`screen/${platform}: logical leg read pixels`);
    }

    if (print != null) {
      const matrix = array(print.requiredMatrix);
      const mutations = array(print.mutations).map(record);
      if (print.schemaVersion !== 1 || print.pass !== true
          || print.verdict !== "public-print-fragment-transport-unavailable-fail-closed")
        blockers.push(`paged/${platform}: public print boundary did not fail closed exactly`);
      if (new Set(matrix.map(String)).size !== PAGED_MATRIX_CELLS)
        blockers.push(`paged/${platform}: print matrix incomplete`);
      if (!trueRecord(print.discriminators))
        blockers.push(`paged/${platform}: print ownership discriminators incomplete`);
      if (mutations.length !== PAGED_MUTATIONS || mutations.some((row) => row?.moved !== true))
        blockers.push(`paged/${platform}: print mutation matrix incomplete`);
    }

    if (paint != null) {
      if (paint.schemaVersion !== 1 || paint.verdict !== "ratified-source-exact"
          || array(paint.findings).length !== 0 || paint.ratifiedRows !== FINAL_INK_ROWS
          || paint.unratifiedRows !== 0 || array(paint.unratifiedFamilies).length !== 0)
        blockers.push(`ink/${platform}: native final-ink envelope did not pass independently`);
      const scenarios = array(paint.scenarios).map(record);
      if (scenarios.length !== 9 || scenarios.some((row) => row?.pass !== true))
        blockers.push(`ink/${platform}: native Cartesian scenario matrix incomplete`);
      if (!/^[a-f0-9]{64}$/.test(String(paint.artifactSetSha256 ?? "")))
        blockers.push(`ink/${platform}: artifact-set identity missing`);
    }
  }

  const unique = [...new Set(blockers)];
  return {
    ready: unique.length === 0,
    blockers: unique,
    summary: `${unique.length === 0 ? "READY" : "NOT READY"}: ${unique.length} fragmented-table release blocker(s)`,
  };
}

function findReports(root: string, name: string): unknown[] {
  const found: unknown[] = [];
  const visit = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && basename(child) === name)
        found.push(JSON.parse(readFileSync(child, "utf8")) as unknown);
    }
  };
  visit(root);
  return found;
}

function option(args: string[], name: string): string {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? "" : "";
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = resolve(option(process.argv.slice(2), "--reports"));
  if (!option(process.argv.slice(2), "--reports")) throw new Error("--reports is required");
  const result = adjudicateFragmentedCollapsedTableRelease(
    findReports(root, "screen-logical.json"),
    findReports(root, "paged-logical.json"),
    findReports(root, "final-ink.json"),
  );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ready) process.exitCode = 1;
}
