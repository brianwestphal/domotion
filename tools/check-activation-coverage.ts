import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadActivationLedger, validateActivationLedger, writeActivationEvidence } from "./activation-coverage.js";
import { flag, isMain, parseFlags, runMain } from "./lib/cli.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export async function checkActivationCoverage(argv: string[]): Promise<number> {
  const args = parseFlags(argv, { json: { type: "string" } });
  const ledger = await loadActivationLedger(resolve(root, "tools/activation-coverage.json"));
  const errors = await validateActivationLedger(ledger, root);
  if (errors.length) {
    for (const error of errors) console.error(`- ${error}`);
    return 1;
  }
  const output = flag(args, "json");
  if (typeof output === "string") await writeActivationEvidence(resolve(root, output), ledger);
  console.log(
    `Activation coverage is structurally valid (${ledger.mechanisms.length} mechanisms; positive, negative, and mutation controls linked).`,
  );
  return 0;
}

if (isMain(import.meta.url)) await runMain(() => checkActivationCoverage(process.argv.slice(2)));
