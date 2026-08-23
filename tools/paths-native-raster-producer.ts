import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathsRasterRowSchema } from "./paths-native-raster-gate.js";

const arg = (name: string): string => { const i = process.argv.indexOf(name); if (i < 0 || process.argv[i + 1] == null) throw new Error(`missing ${name}`); return process.argv[i + 1]; };
const input = JSON.parse(readFileSync(arg("--observations"), "utf8")) as unknown[];
const rows = input.map((raw) => {
  const candidate = raw as Record<string, any>;
  for (const role of ["nativeArtifact", "pathsArtifact"] as const) {
    const artifact = candidate[role];
    if (artifact?.path == null) throw new Error(`${candidate.id ?? "row"}: missing ${role}.path`);
    const bytes = readFileSync(artifact.path);
    if (bytes.length < 24 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error(`${candidate.id ?? "row"}: ${role} is not a PNG`);
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    if (artifact.width !== width || artifact.height !== height) throw new Error(`${candidate.id ?? "row"}: ${role} dimensions ${artifact.width}x${artifact.height} do not match PNG ${width}x${height}`);
    artifact.sha256 = createHash("sha256").update(bytes).digest("hex");
  }
  return pathsRasterRowSchema.parse(candidate);
});
writeFileSync(arg("--out"), JSON.stringify(rows, null, 2));
console.log(`Produced ${rows.length} lossless, fingerprinted paths/native raster rows.`);
