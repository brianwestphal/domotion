import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateParityRelease, loadParityReleaseEvidence } from "./parity-release-gate.js";
import { flag, isMain, parseFlags, runMain } from "./lib/cli.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export async function checkParityRelease(argv: string[]): Promise<number> {
  const args = parseFlags(argv, { evidence: { type: "string" }, "report-only": { type: "boolean" } });
  const evidencePath = String(flag(args, "evidence", "tools/parity-release-evidence.json"));
  const result = await evaluateParityRelease(root, await loadParityReleaseEvidence(resolve(root, evidencePath)));
  console.log(`Chromium parity release gate — ${result.summary}`);
  for (const blocker of result.blockers) console.log(`BLOCKER ${blocker}`);
  for (const boundary of result.unsupported) console.log(`UNSUPPORTED ${boundary}`);
  return result.ready || flag(args, "report-only", false) === true ? 0 : 1;
}

if (isMain(import.meta.url)) await runMain(() => checkParityRelease(process.argv.slice(2)));
