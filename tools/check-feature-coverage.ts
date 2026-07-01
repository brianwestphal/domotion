/**
 * Coverage-by-feature report (DM-1459) — `npm run check:features`.
 *
 * Orthogonal to line/branch coverage: it does not measure execution, it maps the
 * documented public surface to the feature index (`tests/feature-coverage.ts`)
 * and flags anything undocumented-yet-shipped or documented-yet-untested.
 *
 * Fails (exit 1) on:
 *   - GAP        — a feature with no asserting test (`tests: []`).
 *   - BROKEN REF — a `tests` path that no longer exists on disk.
 *   - DRIFT      — a public value-export (from the package barrel) or a CLI
 *                  verb/bin claimed by NO feature. This is what keeps the index
 *                  honest: ship a new export/verb without a feature entry and
 *                  this turns red, even at 100% line coverage.
 *
 * Run: `npm run check:features` (or `tsx tools/check-feature-coverage.ts`).
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { FEATURES } from "../tests/feature-coverage.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** CLI verbs dispatched by the `domotion` bin + the standalone published bins.
 *  Kept in step with `src/cli/index.ts` dispatch + `package.json` `bin`. */
const VERBS = ["capture", "animate", "term", "template", "composite"];

const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
  bin?: Record<string, string>;
};
const BINS = Object.keys(pkg.bin ?? {});

async function main(): Promise<void> {
  const problems: string[] = [];
  const warn = (s: string): void => { problems.push(s); };

  // ── 1. Manifest well-formedness ──
  const ids = new Set<string>();
  const dupIds: string[] = [];
  for (const f of FEATURES) {
    if (ids.has(f.id)) dupIds.push(f.id);
    ids.add(f.id);
  }

  // ── 2. Broken test refs + gaps ──
  const gaps: string[] = [];
  const brokenRefs: string[] = [];
  for (const f of FEATURES) {
    if (f.tests.length === 0) { gaps.push(f.id); continue; }
    for (const t of f.tests) {
      if (!existsSync(resolve(ROOT, t))) brokenRefs.push(`${f.id} → ${t}`);
    }
  }

  // ── 3. Export drift — every public value-export must be claimed ──
  const barrel = (await import("../src/index.js")) as Record<string, unknown>;
  const publicExports = Object.keys(barrel)
    .filter((k) => typeof barrel[k] === "function" || typeof barrel[k] === "object")
    .sort();
  const claimedExports = new Set(FEATURES.flatMap((f) => f.exports ?? []));
  const unclaimedExports = publicExports.filter((e) => !claimedExports.has(e));
  // A claimed export that no longer exists is also drift (stale index entry).
  const staleExports = [...claimedExports].filter((e) => !publicExports.includes(e));

  // ── 4. Verb / bin drift ──
  const claimedVerbs = new Set(FEATURES.flatMap((f) => f.verbs ?? []));
  const unclaimedVerbs = [...VERBS, ...BINS].filter((v) => !claimedVerbs.has(v));

  // ── Report ──
  const total = FEATURES.length;
  const transitions = FEATURES.filter((f) => f.transition != null).length;
  console.log(`\nFeature coverage — ${total} features (${transitions} carry a state-transition assertion)`);
  console.log(`Public exports: ${publicExports.length} · claimed by index: ${publicExports.length - unclaimedExports.length}`);
  console.log(`CLI verbs + bins: ${VERBS.length + BINS.length} · claimed: ${VERBS.length + BINS.length - unclaimedVerbs.length}\n`);

  if (dupIds.length > 0) {
    console.log(`❌ ${dupIds.length} duplicate feature id(s): ${dupIds.join(", ")}`);
    warn(`${dupIds.length} duplicate id(s)`);
  }
  if (brokenRefs.length > 0) {
    console.log(`❌ ${brokenRefs.length} broken test ref(s) (feature points at a missing test file):`);
    for (const b of brokenRefs) console.log(`   - ${b}`);
    warn(`${brokenRefs.length} broken test ref(s)`);
  }
  if (gaps.length > 0) {
    console.log(`❌ ${gaps.length} feature(s) with NO asserting test (documented behavior, untested):`);
    for (const g of gaps) console.log(`   - ${g}`);
    warn(`${gaps.length} untested feature(s)`);
  }
  if (unclaimedExports.length > 0) {
    console.log(`❌ ${unclaimedExports.length} public export(s) claimed by NO feature (add an index entry):`);
    for (const e of unclaimedExports) console.log(`   - ${e}`);
    warn(`${unclaimedExports.length} unclaimed export(s)`);
  }
  if (staleExports.length > 0) {
    console.log(`❌ ${staleExports.length} index entry export(s) that no longer exist (stale):`);
    for (const e of staleExports) console.log(`   - ${e}`);
    warn(`${staleExports.length} stale export ref(s)`);
  }
  if (unclaimedVerbs.length > 0) {
    console.log(`❌ ${unclaimedVerbs.length} CLI verb/bin claimed by NO feature:`);
    for (const v of unclaimedVerbs) console.log(`   - ${v}`);
    warn(`${unclaimedVerbs.length} unclaimed verb/bin(s)`);
  }

  if (problems.length === 0) {
    console.log("✅ Every public export + CLI verb/bin is claimed by a feature, and every feature has an asserting test.\n");
    process.exit(0);
  }
  console.log(`\n💥 Feature-coverage check failed: ${problems.length} problem(s).`);
  console.log("   Fix: add the missing test, add/repair the feature entry in tests/feature-coverage.ts,");
  console.log("   or map the new export/verb to a feature. See docs/83-feature-coverage.md.\n");
  process.exit(1);
}

main().catch((err) => {
  console.error("check-feature-coverage crashed:", err);
  process.exit(2);
});
