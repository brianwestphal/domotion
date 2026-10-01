#!/usr/bin/env tsx
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { compareRollArtifacts, type RollArtifact, type RollReview } from "../src/review/roll-differential.js";
import { flag, isMain, parseFlags, requiredFlag, runMain } from "./lib/cli.js";

export function compareRollEvidence(argv: string[]): number {
  const args = parseFlags(argv, {
    old: { type: "string" },
    new: { type: "string" },
    review: { type: "string" },
    out: { type: "string" },
  });
  const old = requiredFlag(args, "old");
  const next = requiredFlag(args, "new");
  const load = <T>(p: string) => JSON.parse(readFileSync(resolve(p), "utf8")) as T;
  const hydrate = (path: string): RollArtifact => {
    const manifest = load<RollArtifact>(path);
    const base = dirname(resolve(path));
    manifest.reportPayloads = Object.fromEntries(
      manifest.reports.flatMap((report) => {
        const file = (report as { reportFile?: string }).reportFile;
        const candidate = file ? resolve(base, file) : "";
        return file && existsSync(candidate) ? [[report.area, load<unknown>(candidate)]] : [];
      }),
    );
    return manifest;
  };
  const result = compareRollArtifacts(
    hydrate(old),
    hydrate(next),
    flag(args, "review") ? load<RollReview>(String(flag(args, "review"))) : undefined,
  );
  const text = JSON.stringify(result, null, 2) + "\n";
  if (flag(args, "out")) writeFileSync(resolve(String(flag(args, "out"))), text);
  else process.stdout.write(text);
  return result.pass ? 0 : 1;
}

if (isMain(import.meta.url)) await runMain(() => compareRollEvidence(process.argv.slice(2)));
