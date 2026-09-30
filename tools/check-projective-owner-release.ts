import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { EXIT_AGREE, EXIT_MISMATCH, isMain, parseFlags, requiredFlag, runMain } from "./lib/cli.js";
import { findProjectiveOwnerReports, verifyProjectiveOwnerArtifacts } from "./projective-owner-artifact-integrity.js";
import { adjudicateProjectiveOwnerRelease } from "./projective-owner-release-gate.js";

export async function checkProjectiveOwnerRelease(argv: string[]): Promise<number> {
  const values = parseFlags(argv, { reports: { type: "string" } });
  const paths = await findProjectiveOwnerReports(resolve(requiredFlag(values, "--reports")));
  const inputs = await Promise.all(paths.map(async (path) => JSON.parse(await readFile(path, "utf8")) as unknown));
  const integrity: string[] = [];
  for (let i = 0; i < inputs.length; i++)
    integrity.push(...(await verifyProjectiveOwnerArtifacts(paths[i], inputs[i])));
  const result = adjudicateProjectiveOwnerRelease(inputs, integrity);
  console.log(`projective owner release gate: ${result.ready ? "READY" : "BLOCKED"}`);
  for (const blocker of result.blockers) console.log(`BLOCKER ${blocker}`);
  return result.ready ? EXIT_AGREE : EXIT_MISMATCH;
}

if (isMain(import.meta.url)) await runMain(() => checkProjectiveOwnerRelease(process.argv.slice(2)));
