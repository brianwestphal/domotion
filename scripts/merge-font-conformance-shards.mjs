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
export function mergeShards(shards, opts = {}) {
  const summary = {};
  const byStack = {};
  const byPair = {};
  const chromeFaces = {};
  const missingShards = [];
  let meta = null;

  let stacksSwept = 0;
  for (const { name, report } of shards) {
    if (report == null) { missingShards.push(name); continue; }
    // The first shard's meta describes the run; every shard shares the corpus,
    // the universe and the flags, and differs only in WHICH stacks it swept —
    // so the stack count is summed rather than taken from one shard, which
    // would record a six-stack sweep as a one-stack slice and make it look
    // comparable to a genuinely different run.
    if (meta == null) meta = report.meta ?? null;
    stacksSwept += report.meta?.stacks ?? 0;
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

  return {
    meta: {
      suite: "font-conformance",
      os: opts.os ?? null,
      image: opts.image ?? null,
      capturedAt: new Date().toISOString(),
      platform: meta?.platform ?? null,
      arch: meta?.arch ?? null,
      node: meta?.node ?? null,
      unicode: meta?.unicode ?? null,
      icu: meta?.icu ?? null,
      corpus: {
        file: meta?.stacksFile ?? null,
        generatedAt: meta?.stackCorpusGeneratedAt ?? null,
        platform: meta?.stackCorpusPlatform ?? null,
      },
      slice: { ...sliceOf(meta), stacks: stacksSwept },
      fontInventory: opts.fontInventory ?? null,
      shardsExpected: expected,
      shardsMerged: shards.length - missingShards.length,
      missingShards,
      /** False ⇒ the numbers below describe part of the sweep and are not a verdict. */
      complete: merged,
    },
    summary,
    byStack,
    byPair,
    chromeFaces,
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
  // Windows sweep it is merging. Each shard drops both next to its report, so
  // they are read from a shard rather than measured here.
  const fromShard = (file) => {
    for (const n of names) {
      const p = join(dir, n, file);
      if (existsSync(p)) return readFileSync(p, "utf8");
    }
    return null;
  };
  let fontInventory = null;
  const invText = invPath != null && existsSync(invPath)
    ? readFileSync(invPath, "utf8")
    : fromShard("font-inventory.json");
  if (invText != null) {
    const doc = JSON.parse(invText);
    // Only the identity, not the 2,000-name list: the list belongs in the
    // artifact, the digest is what a baseline compares.
    fontInventory = { digest: doc.digest, count: doc.count, source: doc.source };
  }
  const imageId = image ?? fromShard("runner-image.txt")?.trim() ?? null;
  const shards = names.map((name) => {
    const f = join(dir, name, "report.json");
    return { name, report: existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null };
  });

  const doc = mergeShards(shards, { os, expected, image: imageId, fontInventory });
  writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
  process.stderr.write(
    `merged ${doc.meta.shardsMerged}/${doc.meta.shardsExpected} shard reports → ${out}`
    + `${doc.meta.complete ? "" : ` (INCOMPLETE: missing ${doc.meta.missingShards.join(", ") || "shard artifacts"})`}\n`,
  );
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) main();
