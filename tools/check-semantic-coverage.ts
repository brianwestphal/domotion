import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSemanticCoverage, semanticCoverageReport, validateSemanticCoverage } from "./semantic-coverage.js";
import { flag, isMain, parseFlags, runMain } from "./lib/cli.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export async function checkSemanticCoverage(argv: string[]): Promise<number> {
  const args = parseFlags(argv, { "fail-on-gaps": { type: "boolean" } });
  const inventory = await loadSemanticCoverage(resolve(root, "tools/semantic-coverage.json"));
  const validation = await validateSemanticCoverage(inventory, root);

  console.log(semanticCoverageReport(inventory));
  if (validation.errors.length > 0) {
    console.error("\nSemantic coverage inventory errors:");
    for (const error of validation.errors) console.error(`- ${error}`);
    return 1;
  }

  if (flag(args, "fail-on-gaps", false) === true && validation.uncovered.length > 0) {
    console.error(`\n${validation.uncovered.length} explicitly uncovered transition families remain.`);
    return 1;
  }

  console.log("\nSemantic coverage inventory is structurally valid; acknowledged gaps are listed above.");
  return 0;
}

if (isMain(import.meta.url)) await runMain(() => checkSemanticCoverage(process.argv.slice(2)));
