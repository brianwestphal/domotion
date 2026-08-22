import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import sharp from "sharp";
import {
  adjudicateNativeScrollbarReports,
  nativeScrollbarAuditReportSchema,
  type NativeScrollbarRasterEnvelope,
} from "./native-scrollbar-release-gate.js";

function option(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

async function jsonFiles(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) return jsonFiles(child);
    return entry.isFile() && extname(entry.name) === ".json" && entry.name === "report.json" ? [child] : [];
  }));
  return nested.flat();
}

async function verifyArtifacts(reportPath: string, input: unknown): Promise<string[]> {
  const parsed = nativeScrollbarAuditReportSchema.safeParse(input);
  if (!parsed.success) return [];
  const blockers: string[] = [];
  const reportRoot = dirname(reportPath);
  for (const row of parsed.data.rows) {
    for (const artifact of row.artifacts) {
      const path = resolve(reportRoot, artifact.path);
      const display = `${parsed.data.environment.platform}/${row.id}@${row.deviceScaleFactor}x/z${row.cssZoom}/${artifact.role}-${artifact.part}`;
      if (relative(reportRoot, path).startsWith("..")) {
        blockers.push(`${display}: artifact path escapes its report directory`);
        continue;
      }
      try {
        const bytes = await readFile(path);
        const digest = createHash("sha256").update(bytes).digest("hex");
        const metadata = await sharp(bytes).metadata();
        if (metadata.format !== "png") blockers.push(`${display}: strip artifact is not lossless PNG`);
        if (digest !== artifact.sha256) blockers.push(`${display}: strip SHA-256 does not match report`);
        if (metadata.width !== artifact.pngWidth || metadata.height !== artifact.pngHeight) {
          blockers.push(`${display}: decoded PNG dimensions do not match report`);
        }
      } catch (error) {
        blockers.push(`${display}: strip artifact unreadable (${error instanceof Error ? error.message : String(error)})`);
      }
    }
  }
  return blockers;
}

const reportsDir = option("--reports");
if (reportsDir == null) throw new Error("usage: check-native-scrollbar-release --reports <downloaded-artifact-dir> [--envelopes <json>]");
const reportPaths = (await jsonFiles(resolve(reportsDir))).sort();
const reports = await Promise.all(reportPaths.map(async (path) => JSON.parse(await readFile(path, "utf8")) as unknown));
const integrity = (await Promise.all(reportPaths.map((path, index) => verifyArtifacts(path, reports[index])))).flat();
const envelopesPath = option("--envelopes");
const envelopes = envelopesPath == null
  ? []
  : JSON.parse(await readFile(resolve(envelopesPath), "utf8")) as NativeScrollbarRasterEnvelope[];
const result = adjudicateNativeScrollbarReports(reports, envelopes, integrity);

console.log(`native scrollbar release gate — ${result.summary}`);
for (const blocker of result.blockers) console.log(`BLOCKER ${blocker}`);
if (!result.ready && !process.argv.includes("--report-only")) process.exitCode = 1;
