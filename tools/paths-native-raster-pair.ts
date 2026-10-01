import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { isMain, parseFlags, requiredFlag, runMain } from "./lib/cli.js";
import { fingerprintSha256, readPathsRasterRows, type PathsRasterRow } from "./paths-native-raster-gate.js";

type Platform = PathsRasterRow["fingerprint"]["platform"];
type Label = PathsRasterRow["runLabel"];
const PLATFORMS = ["darwin", "linux", "win32"] as const satisfies readonly Platform[];
const LABELS = ["proposal", "validation"] as const satisfies readonly Label[];

export interface RasterArm {
  directory: string;
  runId: string;
  runAttempt: string;
  runnerName: string;
  platform: Platform;
  label: Label;
  fingerprintSha256: string;
  rendererSourceSha256: string;
  oracleSourceSha256: string;
  fontInventorySha256: string;
  cellSetSha256: string;
}

function sourceKey(arm: RasterArm): string {
  return `${arm.rendererSourceSha256}|${arm.oracleSourceSha256}|${arm.fontInventorySha256}`;
}

function armOrder(a: RasterArm, b: RasterArm): number {
  return [a.runId, a.runAttempt, a.runnerName, a.directory]
    .join("|")
    .localeCompare([b.runId, b.runAttempt, b.runnerName, b.directory].join("|"));
}

/** Select the first complete pair per platform in stable order. Every pair
 * has one exact platform fingerprint and source digest, the same declared cells, and distinct
 * native runners; the unchanged aggregate authenticates their PNGs afterward. */
export function chooseRasterPairs(arms: RasterArm[]): RasterArm[] {
  const selected: RasterArm[] = [];
  for (const platform of PLATFORMS) {
    const platformArms = arms.filter((arm) => arm.platform === platform);
    const fingerprints = [...new Set(platformArms.map((arm) => arm.fingerprintSha256))].sort();
    let pair: [RasterArm, RasterArm] | undefined;
    for (const fingerprint of fingerprints) {
      const proposals = platformArms
        .filter((arm) => arm.label === "proposal" && arm.fingerprintSha256 === fingerprint)
        .sort(armOrder);
      const validations = platformArms
        .filter((arm) => arm.label === "validation" && arm.fingerprintSha256 === fingerprint)
        .sort(armOrder);
      for (const proposal of proposals) {
        const validation = validations.find(
          (candidate) =>
            candidate.runnerName !== proposal.runnerName &&
            candidate.cellSetSha256 === proposal.cellSetSha256 &&
            sourceKey(candidate) === sourceKey(proposal),
        );
        if (validation != null) {
          pair = [proposal, validation];
          break;
        }
      }
      if (pair != null) break;
    }
    if (pair == null)
      throw new Error(`no complete same-source, exact-fingerprint, independent-runner pair for ${platform}`);
    selected.push(...pair);
  }
  return selected;
}

function readArm(directory: string, runId: string, allowedFingerprints: Set<string>): RasterArm | undefined {
  const rows = readPathsRasterRows(resolve(directory, "paths-native-raster-rows.json"), "paths-native-raster-producer");
  if (rows.length !== 348) return undefined;
  const first = rows[0];
  const fingerprint = fingerprintSha256(first.fingerprint);
  const provenance = JSON.stringify(first.runProvenance);
  const cells = rows.map((row) => row.cellSha256);
  if (
    first.runProvenance.githubRunId !== runId ||
    !first.runProvenance.workflowRef.includes("/.github/workflows/paths-native-raster-floor.yml@") ||
    !allowedFingerprints.has(fingerprint) ||
    new Set(cells).size !== 348 ||
    rows.some(
      (row) =>
        row.runLabel !== first.runLabel ||
        row.fingerprint.platform !== first.fingerprint.platform ||
        fingerprintSha256(row.fingerprint) !== fingerprint ||
        JSON.stringify(row.runProvenance) !== provenance,
    )
  )
    return undefined;
  return {
    directory,
    runId,
    runAttempt: first.runProvenance.githubRunAttempt,
    runnerName: first.runProvenance.runnerName,
    platform: first.fingerprint.platform,
    label: first.runLabel,
    fingerprintSha256: fingerprint,
    rendererSourceSha256: first.fingerprint.rendererSourceSha256,
    oracleSourceSha256: first.fingerprint.oracleSourceSha256,
    fontInventorySha256: first.fingerprint.fontInventorySha256,
    cellSetSha256: createHash("sha256").update(cells.sort().join("\n")).digest("hex"),
  };
}

export function main(argv: string[] = process.argv.slice(2)): void {
  const flags = parseFlags(argv, {
    candidates: { type: "string" },
    envelopes: { type: "string" },
    out: { type: "string" },
    selection: { type: "string" },
  });
  const candidatesRoot = resolve(requiredFlag(flags, "--candidates"));
  const envelopes = resolve(requiredFlag(flags, "--envelopes"));
  const out = resolve(requiredFlag(flags, "--out"));
  const selectionPath = resolve(requiredFlag(flags, "--selection"));
  if (existsSync(out) && readdirSync(out).length > 0) throw new Error(`selection output is not empty: ${out}`);
  const manifest = JSON.parse(readFileSync(envelopes, "utf8")) as {
    schemaVersion: number;
    ratified: boolean;
    envelopes: Array<{ fingerprintSha256: string }>;
  };
  if (manifest.schemaVersion !== 2 || manifest.ratified !== true) throw new Error("ratified v2 envelope file required");
  const allowedFingerprints = new Set(manifest.envelopes.map((entry) => entry.fingerprintSha256));
  const paths = readdirSync(candidatesRoot, { recursive: true })
    .map(String)
    .filter((path) => path.endsWith(`${sep}paths-native-raster-rows.json`));
  const arms: RasterArm[] = [];
  for (const path of paths.sort()) {
    const [runId] = path.split(sep);
    if (!/^\d+$/.test(runId)) throw new Error(`candidate path does not start with a run ID: ${path}`);
    const arm = readArm(resolve(candidatesRoot, dirname(path)), runId, allowedFingerprints);
    if (arm != null) arms.push(arm);
  }
  const chosen = chooseRasterPairs(arms);
  mkdirSync(out, { recursive: true });
  for (const arm of chosen)
    cpSync(arm.directory, resolve(out, `paths-native-raster-${arm.platform}-${arm.label}`), { recursive: true });
  mkdirSync(dirname(selectionPath), { recursive: true });
  writeFileSync(
    selectionPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        selected: chosen.map(({ directory, ...rest }) => ({
          ...rest,
          artifactDirectory: directory.slice(candidatesRoot.length + 1).replaceAll(sep, "/"),
        })),
      },
      null,
      2,
    )}\n`,
  );
  console.log(`Selected ${chosen.length} independently run native-raster artifacts from ${arms.length} eligible arms.`);
}

if (isMain(import.meta.url)) await runMain(() => main());
