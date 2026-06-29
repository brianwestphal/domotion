// DM-1426: compute the per-shard runner-image identifier the CI visual-tests
// workflow records (→ each baseline's `meta.image`, the documented "refresh the
// baseline when the image rotates" signal — see tests/baselines/README.md).
//
// On the GitHub HOST runners (macOS, Windows) the `ImageOS` env names the image
// (e.g. "macOS15" → "macos15-arm64"). The Linux job runs INSIDE the
// `mcr.microsoft.com/playwright:v<ver>-noble` container, where `ImageOS` is unset
// — the old inline `"${ImageOS:-unknown}-${RUNNER_ARCH:-unknown}"` produced the
// meaningless `unknown-x64` for every Linux baseline. In the container we instead
// derive the real identity from `/etc/os-release` + the pinned Playwright version
// (the actual rotation signal: the container tag bumps in lockstep with the
// @playwright/test dependency), e.g. `playwright-v1.59.1-noble-x64`.
//
// The compute is a pure function so it is unit-tested without a runner
// (tests/record-runner-image.test.ts); `main()` gathers the real inputs and
// writes the file. Usage: `node scripts/record-runner-image.mjs [outPath]`
// (writes to outPath, or stdout if omitted).

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Pure: derive the image id from already-gathered inputs.
 * @param {{imageOS?: string, runnerArch?: string, osRelease?: Record<string,string>|null, playwrightVersion?: string|null}} inputs
 * @returns {string} lowercased `<image>-<arch>` (never an empty string)
 */
export function computeRunnerImage(inputs = {}) {
  const { imageOS, runnerArch, osRelease, playwrightVersion } = inputs;
  const arch = (String(runnerArch ?? "").trim() || "unknown");
  // Host runners (macOS / Windows): the runner exposes ImageOS directly.
  if (imageOS != null && String(imageOS).trim() !== "") {
    return `${String(imageOS).trim()}-${arch}`.toLowerCase();
  }
  // Container (Linux): no host ImageOS. Identify by the Ubuntu codename
  // (/etc/os-release) + the Playwright version, so a noble or Playwright bump
  // shows up as a meta.image mismatch instead of a silent `unknown-x64`.
  const codename = (
    osRelease?.VERSION_CODENAME ||
    osRelease?.VERSION_ID ||
    "linux"
  ).toString().trim() || "linux";
  const pw = playwrightVersion != null && String(playwrightVersion).trim() !== ""
    ? `playwright-v${String(playwrightVersion).trim()}-`
    : "";
  return `${pw}${codename}-${arch}`.toLowerCase();
}

/** Parse the subset of /etc/os-release we use (KEY=VALUE, optionally quoted). */
export function parseOsRelease(text) {
  const out = {};
  for (const line of String(text).split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
  }
  return out;
}

function main() {
  const outPath = process.argv[2];
  let osRelease = null;
  let playwrightVersion = null;
  // Only the container path needs the extra lookups; the host path uses ImageOS.
  if (process.env.ImageOS == null || process.env.ImageOS.trim() === "") {
    try { osRelease = parseOsRelease(readFileSync("/etc/os-release", "utf8")); } catch { /* not linux */ }
    try {
      const require = createRequire(import.meta.url);
      playwrightVersion = require("@playwright/test/package.json").version;
    } catch { /* playwright not resolvable */ }
  }
  const id = computeRunnerImage({
    imageOS: process.env.ImageOS,
    runnerArch: process.env.RUNNER_ARCH,
    osRelease,
    playwrightVersion,
  });
  if (outPath) writeFileSync(outPath, id + "\n");
  else process.stdout.write(id + "\n");
  return id;
}

// Run only when invoked directly (not when imported by the unit test).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const id = main();
  console.error(`record-runner-image: ${id}`);
}
