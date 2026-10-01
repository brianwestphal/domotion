#!/usr/bin/env tsx
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import type { ConformanceMode, DecisionRow, SourceDriftEvidence } from "../src/review/source-drift-gate.js";
import { flag, isMain, parseFlags, requiredFlag, runMain } from "./lib/cli.js";
import { writeReport } from "./lib/report.js";

const hashFile = (path: string): string =>
  createHash("sha256")
    .update(readFileSync(resolve(path)))
    .digest("hex");
const revision = (path: string): string =>
  execFileSync("git", ["-C", resolve(path), "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const keyedHashes = (paths: string[]): Record<string, string> =>
  Object.fromEntries(paths.map((path) => [path.replaceAll("\\", "/"), hashFile(path)]));
const chromiumHarfBuzzRevision = (): string => {
  const readme = readFileSync(resolve("external/chromium/third_party/harfbuzz-ng/README.chromium"), "utf8");
  const match = /^Revision:\s*(\S+)/m.exec(readme);
  if (match == null) throw new Error("Chromium HarfBuzz README has no Revision field");
  return match[1];
};
const loadRows = (path: string | undefined): DecisionRow[] =>
  path == null ? [] : (JSON.parse(readFileSync(resolve(path), "utf8")) as DecisionRow[]);

export function main(argv: string[] = process.argv.slice(2)): void {
  const options = parseFlags(argv, {
    mode: { type: "string" },
    "icu-data": { type: "string" },
    out: { type: "string" },
    helper: { type: "string", multiple: true },
    classifier: { type: "string", multiple: true },
    unicode: { type: "string" },
    shaping: { type: "string" },
  });
  const value = (name: string): string | undefined => flag(options, name) as string | undefined;
  const mode = value("--mode") as ConformanceMode | undefined;
  const icuData = value("--icu-data"),
    out = value("--out");
  const helpers = options.helper ?? [],
    classifiers = options.classifier ?? [];
  if (
    (mode !== "representative" && mode !== "exhaustive") ||
    icuData == null ||
    out == null ||
    helpers.length === 0 ||
    classifiers.length === 0
  ) {
    throw new Error(
      "usage: source-drift-evidence --mode representative|exhaustive --icu-data icudtl.dat --helper binary [--helper binary] --classifier generated.ts [--classifier generated.ts] --unicode rows.json --shaping rows.json --out evidence.json",
    );
  }
  const evidence: SourceDriftEvidence = {
    fingerprint: {
      chromiumRevision: revision("external/chromium"),
      chromiumHarfBuzzRevision: chromiumHarfBuzzRevision(),
      harfbuzzRevision: revision("external/harfbuzz"),
      icuRevision: revision("external/chromium/third_party/icu"),
      icuDataSha256: hashFile(icuData),
      helperBinaries: keyedHashes(helpers),
      generatedClassifiers: keyedHashes(classifiers),
    },
    mode,
    unicodeProperties: loadRows(value("--unicode")),
    shapingDecisions: loadRows(value("--shaping")),
  };
  writeReport(
    resolve(requiredFlag(options, "--out")),
    "source-drift-evidence",
    { ...evidence, outcome: "pass" },
    {
      schemaVersion: 1,
      env: { mode },
    },
  );
}

if (isMain(import.meta.url)) await runMain(() => main());
