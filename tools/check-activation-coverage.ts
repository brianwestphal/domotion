import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadActivationLedger, validateActivationLedger, writeActivationEvidence } from "./activation-coverage.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ledger = await loadActivationLedger(resolve(root, "tools/activation-coverage.json"));
const errors = await validateActivationLedger(ledger, root);
if (errors.length) { for (const error of errors) console.error(`- ${error}`); process.exit(1); }
const outputIndex = process.argv.indexOf("--json");
if (outputIndex >= 0) {
  const output = process.argv[outputIndex + 1];
  if (output == null) throw new Error("--json requires a path");
  await writeActivationEvidence(resolve(root, output), ledger);
}
console.log(`Activation coverage is structurally valid (${ledger.mechanisms.length} mechanisms; positive, negative, and mutation controls linked).`);
