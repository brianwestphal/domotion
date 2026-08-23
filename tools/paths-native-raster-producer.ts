import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { assertCompletePathsRasterMatrix } from "./paths-native-raster-corpus.js";
import { pathsRasterRowSchema, type PathsRasterRow } from "./paths-native-raster-gate.js";
import { decodePathsRasterPng, measurePathsRasterResidual } from "./paths-native-raster-metrics.js";

function artifactFile(root: string, rowId: string, role: "nativeArtifact" | "pathsArtifact", path: string): string {
  if (isAbsolute(path)) throw new Error(`${rowId}: ${role}.path must be relative to the observation bundle`);
  const requested = resolve(root, path);
  const requestedRel = relative(root, requested);
  if (requestedRel === "" || requestedRel.startsWith("..") || isAbsolute(requestedRel)) throw new Error(`${rowId}: ${role}.path escapes the observation bundle`);
  const file = realpathSync(requested);
  const rel = relative(root, file);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${rowId}: ${role}.path escapes the observation bundle`);
  return file;
}

export async function producePathsRasterRows(
  rawInput: unknown,
  observationRoot: string,
  options: { requireComplete?: boolean } = {},
): Promise<PathsRasterRow[]> {
  if (!Array.isArray(rawInput)) throw new Error("paths/native observations must be an array");
  const root = realpathSync(resolve(observationRoot));
  const rows: PathsRasterRow[] = [];
  const artifactPaths = new Set<string>();
  for (const raw of rawInput) {
    const candidate = structuredClone(raw) as Record<string, any>;
    const id = typeof candidate.id === "string" ? candidate.id : "row";
    const bytes: Partial<Record<"nativeArtifact" | "pathsArtifact", Buffer>> = {};
    for (const role of ["nativeArtifact", "pathsArtifact"] as const) {
      const artifact = candidate[role];
      if (artifact?.path == null) throw new Error(`${id}: missing ${role}.path`);
      const file = artifactFile(root, id, role, artifact.path);
      if (artifactPaths.has(file)) throw new Error(`${id}: ${role} reuses another evidence artifact`);
      artifactPaths.add(file);
      const image = readFileSync(file);
      if (image.length < 24 || image.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error(`${id}: ${role} is not a PNG`);
      const decoded = await decodePathsRasterPng(image);
      if (artifact.width !== decoded.width || artifact.height !== decoded.height) {
        throw new Error(`${id}: ${role} dimensions ${artifact.width}x${artifact.height} do not match PNG ${decoded.width}x${decoded.height}`);
      }
      artifact.sha256 = createHash("sha256").update(image).digest("hex");
      bytes[role] = image;
    }
    candidate.residual = await measurePathsRasterResidual(bytes.nativeArtifact!, bytes.pathsArtifact!);
    rows.push(pathsRasterRowSchema.parse(candidate));
  }
  const ids = new Set<string>();
  for (const row of rows) {
    if (ids.has(row.id)) throw new Error(`duplicate paths/native raster row id: ${row.id}`);
    ids.add(row.id);
  }
  if (options.requireComplete !== false) assertCompletePathsRasterMatrix(rows);
  return rows;
}

function arg(name: string): string {
  const index = process.argv.indexOf(name);
  if (index < 0 || process.argv[index + 1] == null) throw new Error(`missing ${name}`);
  return process.argv[index + 1];
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const observations = resolve(arg("--observations"));
  const rows = await producePathsRasterRows(JSON.parse(readFileSync(observations, "utf8")), dirname(observations), {
    requireComplete: !process.argv.includes("--allow-partial"),
  });
  writeFileSync(arg("--out"), JSON.stringify(rows, null, 2));
  console.log(`Produced ${rows.length} lossless, fingerprinted paths/native raster rows.`);
}
