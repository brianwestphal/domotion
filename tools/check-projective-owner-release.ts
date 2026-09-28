import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { findProjectiveOwnerReports, verifyProjectiveOwnerArtifacts } from "./projective-owner-artifact-integrity.js";
import { adjudicateProjectiveOwnerRelease } from "./projective-owner-release-gate.js";

const option = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const root = option("--reports");
if (root == null) throw new Error("--reports is required");
const paths = await findProjectiveOwnerReports(resolve(root));
const inputs = await Promise.all(paths.map(async (path) => JSON.parse(await readFile(path, "utf8")) as unknown));
const integrity: string[] = [];
for (let i = 0; i < inputs.length; i++) integrity.push(...(await verifyProjectiveOwnerArtifacts(paths[i], inputs[i])));
const result = adjudicateProjectiveOwnerRelease(inputs, integrity);
console.log(`projective owner release gate: ${result.ready ? "READY" : "BLOCKED"}`);
for (const blocker of result.blockers) console.log(`BLOCKER ${blocker}`);
if (!result.ready) process.exitCode = 1;
