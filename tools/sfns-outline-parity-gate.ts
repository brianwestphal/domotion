/** Exact proposal/validation adjudicator for DM-2567.
 *
 * This gate compares authenticated logical outline evidence only. Terminal
 * mask coverage remains in the sibling diagnostic artifact and never becomes
 * an outline tolerance.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  validateSfnsProposalValidation, type SfnsOracleArtifact,
} from "./sfns-mask-baseline-schema.js";

const argv = process.argv.slice(2);
const value = (flag: string): string | undefined => {
  const index = argv.indexOf(flag);
  return index < 0 ? undefined : argv[index + 1];
};

function readArtifact(flag: "--proposal" | "--validation"): SfnsOracleArtifact {
  const path = value(flag);
  if (path == null) throw new Error(`${flag} report path is required`);
  return JSON.parse(readFileSync(resolve(path), "utf8")) as SfnsOracleArtifact;
}

const proposal = readArtifact("--proposal");
const validation = readArtifact("--validation");
const errors = validateSfnsProposalValidation(proposal, validation);
if (errors.length > 0) {
  throw new Error(`SFNS exact outline parity gate failed: ${errors.join(", ")}`);
}

console.log(
  `SFNS exact outline parity: ${proposal.rows.length} scenarios, `
  + `${proposal.rows.reduce((sum, row) => sum + row.domotionGlyphIds.length, 0)} gid observations, `
  + `proposal/validation digest ${proposal.logicalDigest}`,
);
