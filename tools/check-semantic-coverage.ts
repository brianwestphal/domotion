import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadSemanticCoverage,
  semanticCoverageReport,
  validateSemanticCoverage,
} from "./semantic-coverage.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const inventory = await loadSemanticCoverage(resolve(root, "tools/semantic-coverage.json"));
const validation = await validateSemanticCoverage(inventory, root);

console.log(semanticCoverageReport(inventory));
if (validation.errors.length > 0) {
  console.error("\nSemantic coverage inventory errors:");
  for (const error of validation.errors) console.error(`- ${error}`);
  process.exit(1);
}

if (process.argv.includes("--fail-on-gaps") && validation.uncovered.length > 0) {
  console.error(`\n${validation.uncovered.length} explicitly uncovered transition families remain.`);
  process.exit(1);
}

console.log("\nSemantic coverage inventory is structurally valid; acknowledged gaps are listed above.");
