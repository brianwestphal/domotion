#!/usr/bin/env node
// Fail-fast iteration mode for the font-conformance oracle (DM-1888).
//
//   node scripts/font-conformance-iterate.mjs --chunks 4 \
//     --baseline tests/baselines/font-conformance-macos.json -- --max-stacks 8
//
// Everything after `--` is passed through to `tools/font-conformance.ts`.
//
// WHY THIS EXISTS
//
// The oracle plays two roles that want opposite things. As a JUDGE ("is this
// branch clean?") it must be exhaustive, because its output is a verdict. As a
// FINDER ("what should I fix next?") it only needs to surface ONE real defect —
// and if the loop is going to stop and fix on the first genuine finding, the
// rest of that iteration's work is wasted. Today we only have the judge, and pay
// judge prices on every iteration.
//
// WHY IT IS SAFE TO SAMPLE HERE, AND ONLY HERE
//
// A partial run is SOUND BUT INCOMPLETE. Every row it compares is compared
// exhaustively against Chrome, so anything it FINDS is real — there are no false
// positives. The only risk is a false negative: stopping early and believing you
// are clean. So this tool reports exactly two things:
//
//     FOUND         n new routes (real, actionable — stop and fix)
//     INCONCLUSIVE  no new routes in chunks 1..k of N (NOT "clean")
//
// It is structurally incapable of emitting a mismatch TOTAL or the word clean,
// and it writes no baseline. That single rule removes the failure mode behind
// both of this cycle's false readings — the 1-in-50 Windows stride that said
// 0.488% where the truth was 14.77%, and the hand-picked ranges that happened to
// be the ones the static table owns. Neither number could have been produced by
// this tool, because it does not produce numbers of that kind.
//
// WHAT "NEW" MEANS, AND WHY IT IS ROUTES RATHER THAN COUNTS
//
// A chunk sweeps a fraction of the universe, so its mismatch COUNT is not
// comparable to a baseline's — that comparison is exactly the category error the
// oracle's slice-checking exists to prevent. Route PRESENCE is comparable: a
// (chrome face → our face) pair the baseline never recorded is a new KIND of
// disagreement no matter how much of the universe you swept. So the stopping
// rule is "a route absent from the baseline", never a threshold on a total.
//
// Consequence worth knowing: this finds new KINDS of disagreement, not growth in
// an existing one. A change that doubles an already-known route is invisible
// here and needs the full sweep. Stated rather than left to be discovered.
//
// CHUNKS ARE STRIDED, NOT CONTIGUOUS
//
// Chunk k is `--shard k/N`, which strides the codepoint universe. Since the
// universe is sorted and Unicode blocks are contiguous within it, a block of B
// codepoints contributes about B/N to every chunk — so each chunk independently
// samples every block. A contiguous "first 25%" would instead be U+0000–U+1FFFF:
// all of Latin/Greek/Cyrillic and no CJK at all.

import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Routes (`chrome → ours` pairs) a report or baseline recorded. */
export function routesOf(doc) {
  const out = new Set();
  // Merged baselines key routes in `byPair`; a raw shard report lists them in
  // `topMismatchPairs`. Accept either so a baseline and a chunk compare directly.
  if (doc?.byPair != null) for (const k of Object.keys(doc.byPair)) out.add(k);
  for (const { pair } of doc?.topMismatchPairs ?? []) out.add(pair);
  return out;
}

/**
 * Routes in `chunk` that `baseline` never recorded.
 * @returns {string[]} sorted, so output is stable across runs
 */
export function newRoutes(chunk, baseline) {
  const known = routesOf(baseline);
  return [...routesOf(chunk)].filter((r) => !known.has(r)).sort();
}

function main() {
  const argv = process.argv.slice(2);
  const sep = argv.indexOf("--");
  const mine = sep >= 0 ? argv.slice(0, sep) : argv;
  const passthrough = sep >= 0 ? argv.slice(sep + 1) : [];
  const get = (flag, dflt = null) => {
    const i = mine.indexOf(flag);
    return i >= 0 && mine[i + 1] != null ? mine[i + 1] : dflt;
  };

  const chunks = Math.max(1, parseInt(get("--chunks", "4"), 10) || 4);
  const baselinePath = get("--baseline");
  if (baselinePath == null || !existsSync(baselinePath)) {
    // Refusing is the right failure. Without a baseline every pre-existing
    // disagreement reads as new, so chunk 1 would always "find" something and
    // the tool would be a slower way of learning nothing.
    process.stderr.write(
      "font-conformance-iterate: --baseline <file> is required.\n"
      + "  Every route is 'new' without one, so the stopping rule would fire on chunk 1 every time.\n",
    );
    return 2;
  }
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const outRoot = mkdtempSync(join(tmpdir(), "fc-iterate-"));

  process.stdout.write(
    `font-conformance-iterate: ${chunks} strided chunks, new routes vs ${baselinePath}\n`,
  );

  for (let k = 1; k <= chunks; k++) {
    const outDir = join(outRoot, `chunk-${k}`);
    const args = [
      "tsx", "tools/font-conformance.ts",
      "--shard", `${k}/${chunks}`, "--out", outDir, ...passthrough,
    ];
    const t0 = Date.now();
    // stderr is CAPTURED rather than inherited: CoreText writes a line per
    // hidden-face lookup, which drowns the per-chunk progress this tool exists
    // to show. It is replayed verbatim when a chunk dies, so a real failure is
    // never swallowed — only the routine noise of a working run is.
    const res = spawnSync("npx", args, { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);

    // The tool defines 0 = full agreement and 1 = mismatches found. Anything
    // else means it DIED, and a dead chunk's absent report must not be read as
    // "no new routes" — the same lose-data-and-look-green shape the sharded
    // gate had.
    if (res.status !== 0 && res.status !== 1) {
      process.stderr.write(
        `${res.stderr ?? ""}\nchunk ${k}/${chunks} died with exit ${res.status} — no verdict\n`,
      );
      return 2;
    }
    const reportPath = join(outDir, "report.json");
    if (!existsSync(reportPath)) {
      process.stderr.write(`\nchunk ${k}/${chunks} wrote no report — no verdict\n`);
      return 2;
    }
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    const found = newRoutes(report, baseline);

    process.stdout.write(`  chunk ${k}/${chunks}  ${secs}s  ${found.length} new route(s)\n`);
    if (found.length > 0) {
      process.stdout.write(
        `\nFOUND — ${found.length} route(s) the baseline never recorded, in chunk ${k}/${chunks}:\n`
        + found.map((r) => `    ${r}\n`).join("")
        + `\nStopped here: the remaining ${chunks - k} chunk(s) would not change what to fix next.\n`
        + `Report: ${reportPath}\n`,
      );
      return 0;
    }
  }

  // All chunks ran, so the universe is fully covered — but the claim stays
  // scoped to what was actually compared. No total, and not "clean".
  process.stdout.write(
    `\nNO NEW ROUTES across all ${chunks} chunks (full universe for the given flags).\n`
    + "This says no new KIND of disagreement appeared. It does NOT say the branch is\n"
    + "clean, and it cannot see growth in a route the baseline already records —\n"
    + "run the full sweep for either of those.\n",
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());
