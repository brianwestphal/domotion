import { fileURLToPath } from "node:url";

/** The unsuffixed and rotating-byte baselines represent the complete 351-stack
 * prefix and one full codepoint bucket. A diagnostic stride/filter must never
 * be published under either authoritative name. Ranges have their own hashed
 * filenames and retain their diagnostic flexibility. */
export function validateSyntheticBaselineDispatch(input) {
  if (input.updateBaseline !== "true" || input.range?.trim()) return [];
  const errors = [];
  if (input.maxStacks !== "351") errors.push("baseline updates require max_stacks=351");
  if (input.stackFilter?.trim()) errors.push("baseline updates require an empty stack_filter");
  if (input.noPua === "true") errors.push("baseline updates require no_pua=false");
  if (input.cpShard !== "1" || input.cpTotal !== "1") {
    errors.push("baseline updates require cp_shard=1 and cp_total=1; a codepoint stride is incomplete");
  }
  return errors;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const errors = validateSyntheticBaselineDispatch({
    updateBaseline: process.env.BASELINE_UPDATE,
    range: process.env.BASELINE_RANGE,
    maxStacks: process.env.BASELINE_MAX_STACKS,
    stackFilter: process.env.BASELINE_STACK_FILTER,
    noPua: process.env.BASELINE_NO_PUA,
    cpShard: process.env.BASELINE_CP_SHARD,
    cpTotal: process.env.BASELINE_CP_TOTAL,
  });
  for (const error of errors) process.stderr.write(`::error::${error}\n`);
  if (errors.length > 0) process.exitCode = 2;
}
