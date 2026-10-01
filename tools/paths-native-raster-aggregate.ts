import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isMain, parseFlags, requiredFlag, runMain } from "./lib/cli.js";

import { adjudicatePathsRasterRows, fingerprintSha256, type PathsRasterRow } from "./paths-native-raster-gate.js";
import { producePathsRasterRows } from "./paths-native-raster-producer.js";

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const values = parseFlags(argv, {
    artifacts: { type: "string" },
    envelopes: { type: "string" },
    out: { type: "string" },
  });
  const root = resolve(requiredFlag(values, "--artifacts"));
  const envelopes = resolve(requiredFlag(values, "--envelopes"));
  const out = resolve(requiredFlag(values, "--out"));
  const rowFiles = readdirSync(root, { recursive: true })
    .map(String)
    .filter((file) => file.endsWith("paths-native-raster-rows.json"));
  if (rowFiles.length !== 6)
    throw new Error(`expected proposal + validation artifacts for three platforms, found ${rowFiles.length}`);
  const rows: PathsRasterRow[] = [];
  for (const file of rowFiles) {
    const absolute = resolve(root, file);
    const produced = await producePathsRasterRows(JSON.parse(readFileSync(absolute, "utf8")), dirname(absolute));
    if (
      new Set(produced.map((row) => row.fingerprint.platform)).size !== 1 ||
      new Set(produced.map((row) => fingerprintSha256(row.fingerprint))).size !== 1 ||
      new Set(produced.map((row) => row.runLabel)).size !== 1 ||
      new Set(produced.map((row) => JSON.stringify(row.runProvenance))).size !== 1
    ) {
      throw new Error(`${file}: mixed platform, fingerprint, run label, or run provenance`);
    }
    rows.push(...produced);
  }
  const platforms = new Set(rows.map((row) => row.fingerprint.platform));
  if (
    platforms.size !== 3 ||
    ["darwin", "linux", "win32"].some((target) => !platforms.has(target as PathsRasterRow["fingerprint"]["platform"]))
  ) {
    throw new Error(`incomplete platform matrix: ${[...platforms].join(",")}`);
  }
  for (const target of platforms) {
    const platformRows = rows.filter((row) => row.fingerprint.platform === target);
    const fingerprints = new Set(platformRows.map((row) => fingerprintSha256(row.fingerprint)));
    if (fingerprints.size !== 1) throw new Error(`${target}: proposal and validation fingerprints differ`);
    for (const label of ["proposal", "validation"] as const) {
      const count = platformRows.filter((row) => row.runLabel === label).length;
      if (count !== 348) throw new Error(`${target}/${label}: expected 348 declared matrix rows, found ${count}`);
    }
    const runnerNames = new Set(platformRows.map((row) => row.runProvenance.runnerName));
    if (runnerNames.size !== 2)
      throw new Error(`${target}: proposal and validation must come from independent runners`);
  }
  const report = adjudicatePathsRasterRows(rows, JSON.parse(readFileSync(envelopes, "utf8")));
  writeFileSync(out, JSON.stringify({ schemaVersion: 1, platforms: [...platforms].sort(), ...report }, null, 2));
  console.log(
    `Paths/native raster aggregate: ${rows.length} rows across ${platforms.size} platforms; ${report.pass ? "PASS" : "WITHHELD"}`,
  );
  if (!report.pass) process.exitCode = 1;
}

if (isMain(import.meta.url)) await runMain(() => main());
