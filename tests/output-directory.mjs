import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultOutputRoot = fileURLToPath(new URL("./output", import.meta.url));

/**
 * Match the visual suites' convention: relative overrides use the invocation
 * cwd, while an empty or absent override keeps the script-anchored default.
 * @param {Record<string, string | undefined>} [env]
 */
export function resolveVisualOutputRoot(env = process.env) {
  return env.DOMOTION_OUTPUT_DIR != null && env.DOMOTION_OUTPUT_DIR !== ""
    ? resolve(env.DOMOTION_OUTPUT_DIR)
    : defaultOutputRoot;
}

/** @param {Record<string, string | undefined>} [env] */
export function resolveReviewOutputRoot(env = process.env) {
  return env.REVIEW_OUTPUT_DIR != null && env.REVIEW_OUTPUT_DIR !== ""
    ? resolve(env.REVIEW_OUTPUT_DIR)
    : resolveVisualOutputRoot(env);
}
