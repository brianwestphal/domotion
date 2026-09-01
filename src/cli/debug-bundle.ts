/** Shared reproduction-bundle directory setup for capture and animate. */

import { mkdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

export interface DebugBundleSetup {
  debug: boolean;
  debugDir: string | undefined;
}

/**
 * Resolve and create a CLI debug-bundle directory.
 *
 * `--debug-dir` enables debug by itself and wins over derived naming. Plain
 * `--debug` needs an output path so both commands can use the same
 * `<output-stem>.debug/` contract.
 */
export function setupDebugBundle(
  command: "capture" | "animate",
  debugFlag: boolean | undefined,
  debugDirFlag: string | undefined,
  output: string | undefined,
  log: (msg: string) => void,
): DebugBundleSetup {
  const debug = debugFlag === true || debugDirFlag != null;
  if (!debug) return { debug, debugDir: undefined };

  let debugDir: string;
  if (debugDirFlag != null) {
    debugDir = resolve(debugDirFlag);
  } else if (output != null) {
    const outPath = resolve(output);
    const stem = basename(outPath).replace(/\.svgz?$/i, "");
    debugDir = resolve(dirname(outPath), `${stem}.debug`);
  } else {
    throw new Error(`${command}: --debug requires either --output (so we can derive <output>.debug/) or --debug-dir <path>`);
  }

  mkdirSync(debugDir, { recursive: true });
  log(`Debug bundle → ${debugDir}/`);
  return { debug, debugDir };
}
