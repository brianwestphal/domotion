import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import sharp from "sharp";
import { adjudicateProjectiveOwnerRelease, projectiveOwnerReleaseReportSchema } from "./projective-owner-release-gate.js";

const option = (name: string): string | undefined => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
async function reports(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => entry.isDirectory() ? reports(resolve(path, entry.name)) : entry.name === "report.json" ? [resolve(path, entry.name)] : []))).flat();
}
const root = option("--reports"); if (root == null) throw new Error("--reports is required");
const paths = await reports(resolve(root)); const inputs = await Promise.all(paths.map(async (path) => JSON.parse(await readFile(path, "utf8")) as unknown));
const integrity: string[] = [];
for (let i = 0; i < inputs.length; i++) {
  const parsed = projectiveOwnerReleaseReportSchema.safeParse(inputs[i]); if (!parsed.success) continue;
  for (const row of parsed.data.rows) for (const artifact of row.artifacts) {
    const path = resolve(dirname(paths[i]), artifact.path);
    if (relative(dirname(paths[i]), path).startsWith("..")) { integrity.push(`${row.family}: artifact escapes report root`); continue; }
    try {
      const bytes = await readFile(path); const meta = await sharp(bytes).metadata();
      if (meta.format !== "png") integrity.push(`${row.family}: artifact is not PNG`);
      if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) integrity.push(`${row.family}: SHA mismatch`);
      if (meta.width !== artifact.pngWidth || meta.height !== artifact.pngHeight) integrity.push(`${row.family}: decoded dimensions mismatch`);
    } catch { integrity.push(`${row.family}: artifact unreadable`); }
  }
}
const result = adjudicateProjectiveOwnerRelease(inputs, integrity);
console.log(`projective owner release gate: ${result.ready ? "READY" : "BLOCKED"}`); for (const blocker of result.blockers) console.log(`BLOCKER ${blocker}`);
if (!result.ready) process.exitCode = 1;
