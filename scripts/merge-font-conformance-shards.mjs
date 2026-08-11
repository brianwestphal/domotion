#!/usr/bin/env node
// Merge the per-shard reports of a font-conformance sweep into one document.
//
// Lives in a script rather than inline in the workflow so it can be unit-tested
// (tests/font-conformance-baseline.test.mjs) — the previous inline version
// silently skipped missing shard reports, which is how a run whose
// mismatch-bearing shards died could sum its survivors and report zero.
//
//   node scripts/merge-font-conformance-shards.mjs \
//     --shards <dir> --expected <n> --os <macos|linux|windows> --out merged.json
//
// `--shards <dir>` is the directory `actions/download-artifact` unpacked into:
// one subdirectory per shard, each holding a `report.json`. A shard whose report
// is ABSENT is recorded in `meta.missingShards`; downstream, that withholds the
// verdict rather than being counted as agreement.
//
// Exit code is 0 whatever the numbers say — merging is not judging. The verdict
// belongs to `scripts/diff-font-conformance-baseline.mjs`, which compares the
// merged document against the platform's own committed baseline.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Fold shard reports into one document.
 * @param {Array<{name: string, report: object|null}>} shards
 * @param {{os?: string, expected?: number, image?: string, fontInventory?: object|null}} opts
 */
/** Sum an iterable of numbers. Small, but it keeps the two axis totals in
 *  `mergeShards` reading as the symmetric pair they are. */
function sum(values) {
  let t = 0;
  for (const v of values) t += v;
  return t;
}

/**
 * The environment fields every shard of one run must agree on, and where each
 * is read from. A shard is one CI job on its own runner, so "the run's
 * environment" is only well-defined if they match.
 *
 * This was previously first-wins — `meta` was taken from the first non-null
 * report and the image / inventory from the first shard directory that had the
 * file — on the stated assumption that shards "differ only in WHICH slice they
 * swept". The visual sweep disproved that assumption: `macos-latest` rotated
 * mid-run and shard 5 of 5 executed on macOS 26.4 while shards 1-4 were on
 * 26.5.2. `icu` is the sharp one here, because it decides which codepoints
 * exist at all — i.e. the denominator the merged totals are quoted against.
 */
const ENV_FIELDS = [
  ["platform", (s) => s.report?.meta?.platform],
  ["arch", (s) => s.report?.meta?.arch],
  ["node", (s) => s.report?.meta?.node],
  // The browser that produced the Chrome side. A run whose shards launched
  // different Chromium builds is two oracles merged into one number, and the
  // fields around it can all agree while that is true.
  ["Chromium version", (s) => s.report?.meta?.chromium],
  ["Unicode version", (s) => s.report?.meta?.unicode],
  ["ICU version", (s) => s.report?.meta?.icu],
  ["stack corpus generatedAt", (s) => s.report?.meta?.stackCorpusGeneratedAt],
  // Sampling is part of the question, not merely bookkeeping. A malformed
  // matrix that mixed buckets would otherwise present the first shard's byte
  // beside totals accumulated from several different universes.
  ["sample low byte", (s) => JSON.stringify(s.report?.meta?.sampleByte ?? null)],
  ["codepoint ranges", (s) => JSON.stringify(s.report?.meta?.ranges ?? null)],
  ["stack-shard total", (s) => s.report?.meta?.stackShard?.[1] ?? 1],
  ["codepoint-shard total", (s) => s.report?.meta?.shard?.[1] ?? 1],
  ["runner image", (s) => s.env?.image],
  ["font inventory digest", (s) => s.env?.fontInventory?.digest],
];

/**
 * Check every shard of a run reports the same environment.
 *
 * Returns the conflicts only; the caller keeps using the first shard's values
 * for the non-conflicting fields (they agree, so "first" is "all"). A field
 * absent on a shard is skipped rather than counted as disagreement — an older
 * shard artifact predates a field, and crying wolf there would train readers to
 * ignore the warning.
 *
 * @param {Array<{name: string, report: object|null, env?: object|null}>} shards
 * @returns {Array<{field: string, values: Array<{value: string, shards: string[]}>}>}
 */
export function environmentConflicts(shards) {
  const conflicts = [];
  const present = (shards ?? []).filter((s) => s != null && s.report != null);
  for (const [field, pick] of ENV_FIELDS) {
    const byValue = new Map();
    for (const s of present) {
      const v = pick(s);
      if (v == null || String(v) === "") continue;
      const k = String(v);
      if (!byValue.has(k)) byValue.set(k, []);
      byValue.get(k).push(s.name);
    }
    if (byValue.size > 1) {
      conflicts.push({
        field,
        values: [...byValue.entries()]
          .map(([value, names]) => ({ value, shards: names.sort() }))
          .sort((a, b) => b.shards.length - a.shards.length),
      });
    }
  }
  return conflicts;
}

export function mergeShards(shards, opts = {}) {
  const summary = {};
  const byStack = {};
  const byPair = {};
  const chromeFaces = {};
  const missingShards = [];
  const resolverAnswerDigests = {};
  let meta = null;

  // DM-1887: the two axes must be accounted DIFFERENTLY, and getting either one
  // wrong produces a slice that looks comparable and is not.
  //
  // A shard is identified by (stackShard, cpShard). Stacks are partitioned along
  // the stack axis and the SAME stacks are re-swept by every codepoint shard;
  // codepoints are partitioned along the codepoint axis and the same universe is
  // re-swept by every stack shard. So:
  //
  //   stacks     = sum over DISTINCT stack-shard indices   (summing all reports
  //                would multiply by the number of cp shards)
  //   codepoints = sum over DISTINCT cp-shard indices      (taking one report's
  //                value would understate the universe by that same factor)
  //
  // Keying by index rather than counting reports makes this correct for all
  // three shapes without a special case: a stack-only run has every `shard` null
  // (one cp bucket, the full universe), a codepoint-only run has every
  // `stackShard` null (one stack bucket, all stacks), and a 2-D run has both.
  const stacksByStackShard = new Map();
  const cpsByCpShard = new Map();
  for (const { name, report } of shards) {
    if (report == null) { missingShards.push(name); continue; }
    // The first shard's meta describes the run; every shard shares the corpus,
    // the universe and the flags, and differs only in WHICH slice it swept.
    if (meta == null) meta = report.meta ?? null;
    const si = report.meta?.stackShard?.[0] ?? 0;
    const ci = report.meta?.shard?.[0] ?? 0;
    const sn = report.meta?.stackShard?.[1] ?? 1;
    const cn = report.meta?.shard?.[1] ?? 1;
    if (report.meta?.resolverAnswerDigest != null) {
      resolverAnswerDigests[`stack-${si}/${sn}:codepoint-${ci}/${cn}`] = report.meta.resolverAnswerDigest;
    }
    stacksByStackShard.set(si, report.meta?.stacks ?? 0);
    cpsByCpShard.set(ci, report.meta?.codepoints ?? 0);
    for (const [k, v] of Object.entries(report.summary ?? {})) {
      if (typeof v === "number") summary[k] = (summary[k] ?? 0) + v;
    }
    for (const { stack, count } of report.mismatchesByStack ?? []) {
      byStack[stack] = (byStack[stack] ?? 0) + count;
    }
    for (const { pair, count } of report.topMismatchPairs ?? []) {
      byPair[pair] = (byPair[pair] ?? 0) + count;
    }
    for (const { face, count } of report.chromeFaces ?? []) {
      chromeFaces[face] = (chromeFaces[face] ?? 0) + count;
    }
  }

  // `distinctMismatchPairs` is a set size, not a sum: adding the per-shard
  // counts would double-count a route that two shards both hit.
  summary.distinctMismatchPairs = Object.keys(byPair).length;

  const expected = opts.expected ?? shards.length;
  const merged = missingShards.length === 0 && shards.length >= expected;
  const envConflicts = environmentConflicts(shards);

  return {
    meta: {
      suite: "font-conformance",
      os: opts.os ?? null,
      image: opts.image ?? null,
      capturedAt: new Date().toISOString(),
      platform: meta?.platform ?? null,
      arch: meta?.arch ?? null,
      node: meta?.node ?? null,
      chromium: meta?.chromium ?? null,
      unicode: meta?.unicode ?? null,
      icu: meta?.icu ?? null,
      corpus: {
        file: meta?.stacksFile ?? null,
        generatedAt: meta?.stackCorpusGeneratedAt ?? null,
        platform: meta?.stackCorpusPlatform ?? null,
      },
      slice: {
        ...sliceOf(meta),
        stacks: sum(stacksByStackShard.values()),
        codepoints: sum(cpsByCpShard.values()),
      },
      fontInventory: opts.fontInventory ?? null,
      shardsExpected: expected,
      shardsMerged: shards.length - missingShards.length,
      missingShards,
      /**
       * Fields the shards did NOT agree on. Non-empty ⇒ this run is a blend of
       * more than one environment, so `meta` above describes one shard rather
       * than the run, and the comparator must refuse to judge it.
       */
      envConflicts,
      /** False ⇒ the numbers below describe part of the sweep and are not a verdict. */
      complete: merged,
    },
    summary,
    byStack,
    byPair,
    chromeFaces,
    resolverAnswerDigests,
  };
}

/**
 * The slice a run swept, as the comparable subset of its `meta`.
 *
 * A mismatch count means nothing without it — the same platform sweeping six
 * stacks and sweeping four hundred produces two numbers that look like a
 * regression and are not comparable at all. The baseline records this and the
 * comparator refuses to judge across a difference.
 */
export function sliceOf(meta) {
  return {
    codepoints: meta?.codepoints ?? null,
    stacks: meta?.stacks ?? null,
    includePua: meta?.includePua ?? null,
    ranges: meta?.ranges ?? null,
    sampleByte: meta?.sampleByte ?? null,
    // Chromium and Domotion both keep document-scoped fallback state. Changing
    // either shard denominator changes how many independent document/cache
    // scopes produced the aggregate, so equal stack/codepoint totals alone do
    // not make two runs comparable.
    stackShardTotal: meta?.stackShard?.[1] ?? 1,
    codepointShardTotal: meta?.shard?.[1] ?? 1,
    strictAlias: meta?.strictAlias ?? null,
    lang: meta?.lang ?? null,
  };
}

function main() {
  const args = process.argv.slice(2);
  const get = (flag, dflt = null) => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] != null ? args[i + 1] : dflt;
  };
  const dir = get("--shards", "shards");
  const out = get("--out", "font-conformance-merged.json");
  const os = get("--os");
  const image = get("--image");
  const expected = Number(get("--expected", "0")) || undefined;
  const invPath = get("--font-inventory");

  const names = existsSync(dir) ? readdirSync(dir).sort() : [];

  // The runner image and font inventory describe the SWEEP host, not this one —
  // the aggregate job runs on a different (Linux) runner than the macOS or
  // Windows sweep it is merging. Each shard drops both next to its report.
  //
  // Read them PER SHARD rather than taking the first that exists: two shards of
  // one run can execute on different runner images (measured — see
  // `environmentConflicts`), and a first-wins read reports one shard's
  // environment as though it described the run.
  const readShardFile = (name, file) => {
    const p = join(dir, name, file);
    if (!existsSync(p)) return null;
    try { return readFileSync(p, "utf8"); } catch { return null; }
  };
  const inventoryOf = (text) => {
    if (text == null) return null;
    try {
      const doc = JSON.parse(text);
      // Only the identity, not the 2,000-name list: the list belongs in the
      // artifact, the digest is what a baseline compares.
      return { digest: doc.digest, count: doc.count, source: doc.source };
    } catch { return null; }
  };

  const shards = names.map((name) => {
    const f = join(dir, name, "report.json");
    return {
      name,
      report: existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null,
      env: {
        image: readShardFile(name, "runner-image.txt")?.trim() || null,
        fontInventory: inventoryOf(readShardFile(name, "font-inventory.json")),
      },
    };
  });

  // An explicitly passed --font-inventory / --image overrides the per-shard
  // reads for the RECORDED value, but the agreement check still runs over what
  // the shards themselves reported — otherwise passing the flag would silently
  // paper over a split.
  const withReport = shards.filter((s) => s.report != null);
  const explicitInv = invPath != null && existsSync(invPath) ? inventoryOf(readFileSync(invPath, "utf8")) : null;
  const fontInventory = explicitInv ?? withReport.find((s) => s.env.fontInventory != null)?.env.fontInventory ?? null;
  const imageId = image ?? withReport.find((s) => s.env.image != null)?.env.image ?? null;

  const doc = mergeShards(shards, { os, expected, image: imageId, fontInventory });
  writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
  process.stderr.write(
    `merged ${doc.meta.shardsMerged}/${doc.meta.shardsExpected} shard reports → ${out}`
    + `${doc.meta.complete ? "" : ` (INCOMPLETE: missing ${doc.meta.missingShards.join(", ") || "shard artifacts"})`}\n`,
  );
  for (const c of doc.meta.envConflicts ?? []) {
    const parts = c.values.map((v) => `${v.value} (${v.shards.join(", ")})`);
    process.stderr.write(`  WARNING shards disagree on ${c.field}: ${parts.join(" vs ")}\n`);
  }
  if ((doc.meta.envConflicts ?? []).length > 0) {
    process.stderr.write(
      "  This run is a blend of more than one environment; meta describes one shard, not the run.\n",
    );
  }
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) main();
