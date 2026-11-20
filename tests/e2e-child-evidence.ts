/**
 * Screenshot-failure evidence for browsers launched by child processes of an
 * E2E worker, such as a test that runs the built CLI with
 * `spawnSync(process.execPath, …)`.
 *
 * The worker-side tap in `e2e-browser-evidence.ts` only sees Chromium that
 * Playwright launches inside the Vitest worker. A child Node process has its
 * own `child_process` module and its own Playwright, so the stderr of its
 * browsers used to be lost when the child failed with
 * "Unable to capture screenshot".
 *
 * The worker opts its children in through the environment they inherit.
 * `NODE_OPTIONS` gains `--import` for the `file:` URL of
 * `e2e-child-evidence-preload.mjs` (a bare path breaks on Windows; see
 * `PRELOAD_URL`),
 * `DOMOTION_E2E_CHILD_EVIDENCE=1` arms it, and `DOMOTION_E2E_EVIDENCE_DIR` is
 * pinned to the worker's absolute evidence directory, so a child running in a
 * temporary working directory still writes where the lane's artifact upload
 * looks. The preload (`e2e-child-evidence-tap.mjs`, plain JavaScript; its
 * header explains why no TypeScript loader is used) installs the same
 * Playwright-launcher stderr tap in the child. It also watches the child's own
 * stdout and stderr. When either names the screenshot failure, the child
 * writes one evidence file at exit in the worker's format, with `child:` in
 * its test line. A passing child writes nothing.
 *
 * Coverage limits: a child spawned with an environment that drops
 * `NODE_OPTIONS`, a non-Node child, and a child killed by SIGKILL are not
 * covered.
 */
import { evidenceDirectory } from "./e2e-browser-evidence.js";

/** Set in a child's environment to make the preload install its tap. */
export const CHILD_EVIDENCE_FLAG = "DOMOTION_E2E_CHILD_EVIDENCE";

// A `file:` URL, never a filesystem path. Node's ESM loader treats an
// `--import` specifier as a URL, so a Windows absolute path such as
// `D:\a\tests\x.mjs` parses with the scheme `d:` and every Node child of the
// worker exits with ERR_UNSUPPORTED_ESM_URL_SCHEME before running any of its
// own code. On the Windows runner that killed the owned review and scrubber
// servers before they could report ready. A URL resolves the same everywhere.
const PRELOAD_URL = new URL("./e2e-child-evidence-preload.mjs", import.meta.url).href;

function quoted(specifier: string): string {
  return `"${specifier.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * Opt every Node child this process spawns into child evidence. Idempotent:
 * an environment that already names the preload keeps its NODE_OPTIONS.
 */
export function configureChildBrowserEvidence(
  env: NodeJS.ProcessEnv = process.env,
  preload: string = PRELOAD_URL,
): void {
  env["DOMOTION_E2E_EVIDENCE_DIR"] = evidenceDirectory(env);
  env[CHILD_EVIDENCE_FLAG] = "1";
  const current = env["NODE_OPTIONS"] ?? "";
  if (current.includes(preload)) return;
  const option = `--import ${quoted(preload)}`;
  env["NODE_OPTIONS"] = current.trim() === "" ? option : `${current} ${option}`;
}
