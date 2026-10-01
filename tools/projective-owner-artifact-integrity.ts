import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import sharp from "sharp";
import {
  projectiveOwnerReleaseDataSchema,
  projectiveOwnerReleaseReportSchema,
} from "./projective-owner-release-gate.js";
import { reportEnvelopeSchema } from "./lib/report.js";

/**
 * Report-relative artifact paths are a portable, cross-platform contract: each native collector
 * uploads its report next to its artifacts, and one Linux adjudicator reads all three. A report
 * written by `path.relative` on Windows spells the path with `\`, which POSIX `path.resolve`
 * treats as an ordinary filename character — so every Windows artifact read as missing in the
 * aggregated three-platform tree. Both separators are therefore accepted and resolved segment by
 * segment. Absolute paths (POSIX root, drive letter, UNC) and any `..` segment are refused, since
 * an artifact must live under its own report's directory.
 */
export function portableArtifactSegments(path: string): string[] | undefined {
  if (/^[\\/]/.test(path) || /^[A-Za-z]:/.test(path)) return undefined;
  const segments = path.split(/[\\/]+/).filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0 || segments.includes("..")) return undefined;
  return segments;
}

/** Recursively find every `report.json` beneath `root` (sorted, so output is deterministic). */
export async function findProjectiveOwnerReports(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory()
        ? findProjectiveOwnerReports(resolve(root, entry.name))
        : Promise.resolve(entry.name === "report.json" ? [resolve(root, entry.name)] : []),
    ),
  );
  return nested.flat().sort();
}

/**
 * Verify every artifact a report names: it must stay under the report's own directory, decode as
 * PNG, match its recorded SHA-256, and match its recorded dimensions. Reports that fail the schema
 * are skipped here — the adjudicator reports those as schema rejections.
 */
export async function verifyProjectiveOwnerArtifacts(reportPath: string, input: unknown): Promise<string[]> {
  const enveloped = input != null && typeof input === "object" && ("tool" in input || "data" in input);
  const report = enveloped
    ? reportEnvelopeSchema(projectiveOwnerReleaseDataSchema, {
        tool: "projective-owner-release-producer",
        schemaVersion: 1,
      }).safeParse(input).data?.data
    : projectiveOwnerReleaseReportSchema.safeParse(input).data;
  if (report == null) return [];
  const reportDir = dirname(reportPath);
  const integrity: string[] = [];
  for (const row of report.rows)
    for (const artifact of row.artifacts) {
      const segments = portableArtifactSegments(artifact.path);
      const path = segments == null ? undefined : resolve(reportDir, ...segments);
      if (path == null || !path.startsWith(reportDir + sep)) {
        integrity.push(`${row.family}: artifact escapes report root`);
        continue;
      }
      try {
        const bytes = await readFile(path);
        const meta = await sharp(bytes).metadata();
        if (meta.format !== "png") integrity.push(`${row.family}: artifact is not PNG`);
        if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256)
          integrity.push(`${row.family}: SHA mismatch`);
        if (meta.width !== artifact.pngWidth || meta.height !== artifact.pngHeight)
          integrity.push(`${row.family}: decoded dimensions mismatch`);
      } catch {
        integrity.push(`${row.family}: artifact unreadable`);
      }
    }
  return integrity;
}
