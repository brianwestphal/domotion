import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateParityRelease, loadParityReleaseEvidence } from "./parity-release-gate.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const evidenceArg = process.argv.indexOf("--evidence");
const evidencePath = evidenceArg >= 0 ? process.argv[evidenceArg + 1] : "tools/parity-release-evidence.json";
if (evidencePath == null) throw new Error("--evidence requires a path");
const result = await evaluateParityRelease(root, await loadParityReleaseEvidence(resolve(root, evidencePath)));
console.log(`Chromium parity release gate — ${result.summary}`);
for (const blocker of result.blockers) console.log(`BLOCKER ${blocker}`);
for (const boundary of result.unsupported) console.log(`UNSUPPORTED ${boundary}`);
if (!result.ready && !process.argv.includes("--report-only")) process.exit(1);
