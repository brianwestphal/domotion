// The environment fingerprint a visual sweep is measured in.
//
// Why this exists, concretely. Two macOS unicode sweeps of the IDENTICAL commit
// disagreed on exactly one fixture out of 818, by 4x:
//
//     2070-209F-superscripts-and-subscripts   run1 0.0574   run2 0.0138
//
// That fixture was blamed on five unrelated code changes in turn, three of them
// wrongly, because nothing recorded said the two runs were not the same
// measurement. They were not: `macos-latest` was mid-rollout, and the shard
// carrying that fixture ran on runner image 20260720.0258 (macOS 26.4) in one
// run and 20260728.0273 (macOS 26.5.2) in the other. Chrome's per-codepoint
// fallback for U+2090-U+2093 differs between those two OS versions, so BOTH the
// expected and the actual PNG changed — 688 px and 327 px respectively, at full
// glyph contrast, not antialiasing.
//
// `scripts/record-runner-image.mjs` already recorded an image id, and it was
// structurally incapable of seeing this: it derives from `ImageOS`, which is
// `macOS26` on both images. The fields that moved — `ImageVersion` and
// `os.release()` — were simply not read. So the guard is not "add a check", it
// is "record the things that actually vary".
//
// Three fields carry the signal, and they are deliberately redundant because
// they fail differently:
//
//   imageVersion   GitHub's image build id. Moves on every image rotation,
//                  including ones that change nothing we care about.
//   osRelease      the kernel version. What caught this case.
//   chromium       the BROWSER BUILD. Chromium is on both sides of a visual
//                  diff — it paints `expected.png` and it rasterizes our SVG
//                  into `actual.png` — so a build change moves both, and not
//                  necessarily by the same amount. Measured on one macOS host
//                  with the platform held constant: `font-variant-emoji: emoji`
//                  moves U+00A9 U+2122 U+203C U+263A to the colour emoji font in
//                  147.0.7727.15 and leaves them on the run's primary in
//                  148.0.7778.96. A fixture containing any of those would flip
//                  between the two builds while every other field here stayed
//                  identical — the same shape as the image rotation above.
//   fontInventory  the installed font set — the SEMANTIC ground truth, since
//                  font selection is what a sweep measures. An image rotation
//                  that leaves fonts alone keeps the digest stable. The full
//                  `entries` list rides along beside the digest: the digest
//                  detects a change, the list EXPLAINS one, and only the list
//                  can answer "does this runner even have the face that would
//                  produce this glyph" after the fact.
//
// `image` is carried through unchanged from `record-runner-image.mjs` so the
// existing `meta.image` contract — and every committed baseline keyed on it —
// keeps its current meaning. This record sits ALONGSIDE it.

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { platform as osPlatform, release as osReleaseVersion, arch as osArch } from "node:os";
import { pathToFileURL } from "node:url";

import { computeRunnerImage, parseOsRelease } from "./record-runner-image.mjs";
import { inventoryDocument } from "../tools/font-inventory.mjs";

/**
 * @typedef {object} RunEnv
 * @property {string|null} image           the existing `meta.image` id, unchanged
 * @property {string|null} imageVersion    GitHub's image build id (`ImageVersion`)
 * @property {string|null} osRelease       `os.release()` — the kernel version
 * @property {string|null} chromium        the browser build (`browser.version()`)
 * @property {string|null} platform
 * @property {string|null} arch
 * @property {string|null} node
 * @property {string|null} corpusIdentity
 * @property {{digest: string|null, count: number|null, entries: string[]|null}|null} fontInventory
 */

/**
 * Pure: assemble the environment record from already-gathered inputs.
 *
 * Everything is optional and missing values become `null` rather than throwing
 * or guessing — an absent field compares as "cannot tell", which is the safe
 * direction. Inventing a plausible value here would manufacture exactly the
 * false sameness this record exists to detect.
 *
 * @param {{image?: string|null, imageVersion?: string|null, osRelease?: string|null,
 *          chromium?: string|null, platform?: string|null, arch?: string|null, node?: string|null, corpusIdentity?: string|null,
 *          fontInventory?: {digest?: string|null, count?: number|null, entries?: string[]|null}|null}} [inputs]
 * @returns {RunEnv}
 */
export function computeRunEnv(inputs = {}) {
  const str = (v) => {
    const s = v == null ? "" : String(v).trim();
    return s === "" ? null : s;
  };
  const inv = inputs.fontInventory ?? null;
  return {
    image: str(inputs.image),
    imageVersion: str(inputs.imageVersion),
    osRelease: str(inputs.osRelease),
    chromium: str(inputs.chromium),
    platform: str(inputs.platform),
    arch: str(inputs.arch),
    node: str(inputs.node),
    corpusIdentity: str(inputs.corpusIdentity),
    fontInventory: inv == null ? null : {
      digest: str(inv.digest),
      count: typeof inv.count === "number" ? inv.count : null,
      // Absent on records written before this field existed; `null` reads as
      // "cannot tell", the same convention as every other field here.
      entries: Array.isArray(inv.entries) ? inv.entries.map((e) => String(e)) : null,
    },
  };
}

/** The fields compared between environments, in report order. */
const ENV_FIELDS = [
  ["image", (e) => e?.image],
  ["runner image version", (e) => e?.imageVersion],
  ["OS release", (e) => e?.osRelease],
  ["Chromium", (e) => e?.chromium],
  ["platform", (e) => e?.platform],
  ["arch", (e) => e?.arch],
  ["font inventory digest", (e) => e?.fontInventory?.digest],
  ["corpus identity", (e) => e?.corpusIdentity],
];

/**
 * Do two environment records describe the same machine?
 *
 * Returns human-readable reasons they differ; empty means they agree as far as
 * the recorded fields can tell. Mirrors `comparability()` in
 * `scripts/diff-font-conformance-baseline.mjs`, which does the same job for the
 * font-conformance oracle — the visual sweep simply never had one.
 *
 * A field absent on EITHER side is skipped rather than counted as a difference:
 * an older baseline predates this record entirely, and reporting "everything
 * changed" for it would train readers to ignore the warning.
 */
/**
 * @param {RunEnv|null} runEnv
 * @param {RunEnv|null} baseEnv
 * @returns {string[]}
 */
export function envComparability(runEnv, baseEnv) {
  const reasons = [];
  if (runEnv == null || baseEnv == null) return reasons;
  for (const [what, pick] of ENV_FIELDS) {
    const a = pick(runEnv), b = pick(baseEnv);
    if (a != null && b != null && String(a) !== String(b)) {
      reasons.push(`${what}: run \`${a}\`, baseline \`${b}\``);
    }
  }
  return reasons;
}

/**
 * Fold the per-shard environments of ONE run into a single record, and say
 * whether the shards actually agreed.
 *
 * This is the half that a baseline-vs-run check cannot provide, and it is the
 * half that caught the real defect: within a single sweep, shard 5 ran on a
 * different macOS than shards 1-4. A merged `results.json` is then not one
 * measurement but a blend of two environments, and every downstream comparison
 * — including capturing it as the new baseline — silently inherits the mix.
 *
 * When shards disagree the combined record reports the field as `null` (i.e.
 * "no single value"), so a heterogeneous run cannot masquerade as a clean one
 * by having the first shard's value stand for all of them.
 *
 * @param {Array<{shard?: number|null, env: RunEnv|null}>} entries
 * @returns {{combined: RunEnv, heterogeneous: boolean, conflicts: Array<{field: string, values: Array<{value: string, shards: number[]}>}>}}
 */
export function mergeShardEnvs(entries) {
  const present = (entries ?? []).filter((e) => e != null && e.env != null);
  const conflicts = [];
  const combined = computeRunEnv({});

  const assign = (key, pick, apply) => {
    const byValue = new Map();
    for (const { shard, env } of present) {
      const v = pick(env);
      if (v == null) continue;
      const k = String(v);
      if (!byValue.has(k)) byValue.set(k, []);
      byValue.get(k).push(typeof shard === "number" ? shard : -1);
    }
    if (byValue.size === 0) return;
    if (byValue.size === 1) { apply([...byValue.keys()][0]); return; }
    conflicts.push({
      field: key,
      values: [...byValue.entries()]
        .map(([value, shards]) => ({ value, shards: shards.filter((s) => s >= 0).sort((a, b) => a - b) }))
        .sort((a, b) => b.shards.length - a.shards.length),
    });
    // Leave the combined field null: there IS no single value, and picking one
    // would be the exact silent blend this function exists to surface.
  };

  assign("image", (e) => e?.image, (v) => { combined.image = v; });
  assign("runner image version", (e) => e?.imageVersion, (v) => { combined.imageVersion = v; });
  assign("OS release", (e) => e?.osRelease, (v) => { combined.osRelease = v; });
  assign("Chromium", (e) => e?.chromium, (v) => { combined.chromium = v; });
  assign("platform", (e) => e?.platform, (v) => { combined.platform = v; });
  assign("arch", (e) => e?.arch, (v) => { combined.arch = v; });
  assign("node", (e) => e?.node, (v) => { combined.node = v; });
  assign("corpus identity", (e) => e?.corpusIdentity, (v) => { combined.corpusIdentity = v; });
  assign("font inventory digest", (e) => e?.fontInventory?.digest, (v) => {
    const counts = present.map((e) => e.env?.fontInventory?.count).filter((c) => typeof c === "number");
    // Shards that agree on the digest agree on the list by construction, so the
    // first non-null entries list stands for the run.
    const entries = present.map((e) => e.env?.fontInventory?.entries).find((x) => Array.isArray(x)) ?? null;
    combined.fontInventory = { digest: v, count: counts.length > 0 ? counts[0] : null, entries };
  });

  return { combined, heterogeneous: conflicts.length > 0, conflicts };
}

/**
 * The Chromium build Playwright resolves HERE, read by launching it.
 *
 * Launched rather than declared, and the distinction is the whole point.
 * Playwright's `browsers.json` and `chromium.executablePath()` report the
 * revision Playwright *intends*; neither is a promise about the binary that
 * actually runs. Measured: a Windows VM launched 148.0.7778.96 out of a
 * directory named `chromium-1217` — the pinned 147 revision — and
 * `executablePath()` reported that 1217 path. Recording the declared value
 * would have written 147 for a run that used 148, i.e. manufactured exactly the
 * false sameness this whole record exists to detect.
 *
 * Honest limit, worth stating rather than eliding: this is a SEPARATE launch
 * from the sweep's, so it records what the harness would resolve, not what one
 * particular harness process did. Those can differ only if the installed
 * browser changes mid-job, which does not happen — but it is "what this machine
 * resolves", not "what that run used".
 *
 * Best-effort: a machine with no browser installed records `null`, which reads
 * as "cannot tell" like every other field here. It must never fail a sweep.
 */
async function launchedChromiumVersion() {
  try {
    const { chromium } = await import("@playwright/test");
    const browser = await chromium.launch();
    try { return browser.version(); } finally { await browser.close(); }
  } catch { return null; }
}

/** Gather the real environment on this machine. */
export async function captureRunEnv({ withInventory = true } = {}) {
  let osRelease = null;
  let playwrightVersion = null;
  if (process.env.ImageOS == null || process.env.ImageOS.trim() === "") {
    try { osRelease = parseOsRelease(readFileSync("/etc/os-release", "utf8")); } catch { /* not linux */ }
    try {
      const require = createRequire(import.meta.url);
      playwrightVersion = require("@playwright/test/package.json").version;
    } catch { /* playwright not resolvable */ }
  }
  const image = computeRunnerImage({
    imageOS: process.env.ImageOS,
    runnerArch: process.env.RUNNER_ARCH ?? process.arch,
    osRelease,
    playwrightVersion,
    platform: process.platform,
  });
  let fontInventory = null;
  if (withInventory) {
    // Best-effort: an unreadable font directory must not fail the sweep. A null
    // inventory degrades this field to "cannot tell", which the comparators skip.
    try {
      const doc = inventoryDocument();
      // `entries` rides along, not just the digest. A digest answers "did the
      // font set change"; it cannot answer "does this runner HAVE the face that
      // would explain this glyph", which is the question a post-hoc
      // investigation actually asks — and the one that stalled an investigation
      // into a fixture flipping between two faces, because the only recourse
      // was to re-run CI to find out what was installed.
      fontInventory = { digest: doc.digest, count: doc.count, entries: doc.entries };
    } catch { /* leave null */ }
  }
  return computeRunEnv({
    image,
    chromium: await launchedChromiumVersion(),
    // GitHub host runners expose the image BUILD id here. This is the field
    // whose absence let two different macOS images read as the same runner.
    imageVersion: process.env.ImageVersion,
    osRelease: osReleaseVersion(),
    platform: osPlatform(),
    arch: osArch(),
    node: process.version,
    corpusIdentity: process.env.HTML_TEST_CORPUS_IDENTITY,
    fontInventory,
  });
}

async function main() {
  const outPath = process.argv[2];
  const env = await captureRunEnv();
  const json = `${JSON.stringify(env, null, 2)}\n`;
  if (outPath) writeFileSync(outPath, json);
  else process.stdout.write(json);
  console.error(
    `run-env: image=${env.image ?? "?"} imageVersion=${env.imageVersion ?? "?"} ` +
    `osRelease=${env.osRelease ?? "?"} chromium=${env.chromium ?? "?"} ` +
    `fonts=${env.fontInventory?.digest ?? "?"}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
