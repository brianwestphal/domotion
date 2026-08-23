import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { adjudicatePathsRasterRows } from "./paths-native-raster-gate.js";

const arg = (name: string): string => { const i = process.argv.indexOf(name); if (i < 0 || process.argv[i + 1] == null) throw new Error(`missing ${name}`); return resolve(process.argv[i + 1]); };
const root = arg("--artifacts");
const rowFiles = readdirSync(root, { recursive: true }).map(String).filter((file) => file.endsWith("paths-native-raster-rows.json"));
if (rowFiles.length !== 3) throw new Error(`expected exactly three platform row artifacts, found ${rowFiles.length}`);
const rows = rowFiles.flatMap((file) => JSON.parse(readFileSync(resolve(root, file), "utf8")) as unknown[]);
const platforms = new Set((rows as Array<any>).map((row) => row?.fingerprint?.platform));
if (["darwin", "linux", "win32"].some((platform) => !platforms.has(platform))) throw new Error(`incomplete platform matrix: ${[...platforms].join(",")}`);
const report = adjudicatePathsRasterRows(rows, JSON.parse(readFileSync(arg("--envelopes"), "utf8")));
writeFileSync(arg("--out"), JSON.stringify({ schemaVersion: 1, platforms: [...platforms].sort(), ...report }, null, 2));
console.log(`Paths/native raster aggregate: ${rows.length} rows across ${platforms.size} platforms; ${report.pass ? "PASS" : "WITHHELD"}`);
if (!report.pass) process.exitCode = 1;
