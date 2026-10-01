import { resolve } from "node:path";
import { EXIT_AGREE, EXIT_MISMATCH, isMain, parseFlags, requiredFlag, runMain } from "./lib/cli.js";
import { findProjectiveOwnerReports, verifyProjectiveOwnerArtifacts } from "./projective-owner-artifact-integrity.js";
import { adjudicateProjectiveOwnerRelease, readProjectiveOwnerReleaseReport } from "./projective-owner-release-gate.js";

export async function checkProjectiveOwnerRelease(argv: string[]): Promise<number> {
  const values = parseFlags(argv, { reports: { type: "string" } });
  const paths = await findProjectiveOwnerReports(resolve(requiredFlag(values, "--reports")));
  const inputs = paths.map((path) => {
    try {
      return readProjectiveOwnerReleaseReport(path);
    } catch {
      // Preserve the release gate's mismatch exit status for invalid retained evidence.
      return { schemaVersion: -1 };
    }
  });
  const integrity: string[] = [];
  for (let i = 0; i < inputs.length; i++)
    integrity.push(...(await verifyProjectiveOwnerArtifacts(paths[i], inputs[i])));
  const result = adjudicateProjectiveOwnerRelease(inputs, integrity);
  console.log(`projective owner release gate: ${result.ready ? "READY" : "BLOCKED"}`);
  for (const blocker of result.blockers) console.log(`BLOCKER ${blocker}`);
  return result.ready ? EXIT_AGREE : EXIT_MISMATCH;
}

if (isMain(import.meta.url)) await runMain(() => checkProjectiveOwnerRelease(process.argv.slice(2)));
