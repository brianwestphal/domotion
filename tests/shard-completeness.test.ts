/**
 * A merged sweep must be able to tell a complete run from a partial one.
 *
 * The case these pin, verbatim: a 5-way macOS unicode run lost shard 5 entirely.
 * The shard job ran to completion but produced no artifact, the aggregate merged
 * the other four, and the run reported "✅ No regressions vs the CI baseline"
 * over 655 of 818 fixtures. The loss is silent in the direction that matters —
 * the missing shard's failures are not there to be counted, so a regression
 * living in it reads as a clean pass. The 163 lost fixtures were Tibetan,
 * Kannada, Gurmukhi, Arabic Supplement, IPA Extensions: complex-script blocks,
 * i.e. exactly the ones a shaping change is most likely to disturb.
 *
 * It also produced a false A/B. Diffing that run against a complete one showed
 * "2 newly passing, 0 fixtures moved" — both artifacts of comparing only the
 * fixture names present in BOTH runs. The two "newly passing" fixtures were not
 * passing; they were absent.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(process.cwd(), "scripts/merge-shard-results.mjs");

/** Lay out `<dir>/results-<os>-shard<i>/results.json` the way CI does. */
function shardDir(root: string, os: string, shard: number, fixtures: string[]) {
  const d = join(root, `results-${os}-shard${shard}`);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "results.json"), JSON.stringify(
    fixtures.map((name) => ({ name, pass: true, skipped: false, diffPct: 0, regionCount: 0 })),
  ));
  writeFileSync(join(d, "run-env.json"), JSON.stringify({ image: "macos26-arm64", platform: "darwin" }));
  return d;
}

function runMerge(root: string, expectArg?: string) {
  const args = [SCRIPT, "--input", root, "--out", root, "--summary", join(root, "summary.md")];
  if (expectArg != null) args.push("--expect", expectArg);
  try {
    execFileSync("node", args, { encoding: "utf-8", stdio: "pipe" });
    return { code: 0, summary: readFileSync(join(root, "summary.md"), "utf-8") };
  } catch (e) {
    const err = e as { status?: number };
    return { code: err.status ?? 1, summary: existsSync(join(root, "summary.md")) ? readFileSync(join(root, "summary.md"), "utf-8") : "" };
  }
}

describe("shard completeness", () => {
  it("FAILS the merge when a shard is missing, instead of reporting the survivors", () => {
    const root = mkdtempSync(join(tmpdir(), "shardc-"));
    for (const i of [1, 2, 3, 4]) shardDir(root, "macos", i, [`fx-${i}a`, `fx-${i}b`]);
    // shard 5 dispatched, never arrived — the observed case.
    const { code, summary } = runMerge(root, "macos=5");

    expect(code, "an incomplete merge must exit non-zero").not.toBe(0);
    expect(summary).toContain("INCOMPLETE RUN");
    expect(summary).toContain("Missing shard(s): 5");

    const c = JSON.parse(readFileSync(join(root, "shard-completeness-macos.json"), "utf-8"));
    expect(c.complete).toBe(false);
    expect(c.expectedShards).toBe(5);
    expect(c.missingShards).toEqual([5]);
    // The count that would otherwise have been quoted as the corpus.
    expect(c.fixtures).toBe(8);
  });

  it("passes a complete run and records it as complete", () => {
    const root = mkdtempSync(join(tmpdir(), "shardc-"));
    for (const i of [1, 2, 3, 4, 5]) shardDir(root, "macos", i, [`fx-${i}`]);
    const { code } = runMerge(root, "macos=5");
    expect(code).toBe(0);
    const c = JSON.parse(readFileSync(join(root, "shard-completeness-macos.json"), "utf-8"));
    expect(c.complete).toBe(true);
    expect(c.missingShards).toEqual([]);
    expect(c.observedShards).toEqual([1, 2, 3, 4, 5]);
  });

  it("catches the loudest-but-quietest case: an OS dispatched that produced NOTHING", () => {
    // This one never enters the per-OS merge loop at all, so without an explicit
    // sweep over the expected set it vanishes from the summary rather than
    // reporting zero.
    const root = mkdtempSync(join(tmpdir(), "shardc-"));
    for (const i of [1, 2]) shardDir(root, "macos", i, [`fx-${i}`]);
    const { code, summary } = runMerge(root, "macos=2,linux=3");
    expect(code).not.toBe(0);
    expect(summary).toContain("NO RESULTS AT ALL");
    const c = JSON.parse(readFileSync(join(root, "shard-completeness-linux.json"), "utf-8"));
    expect(c.complete).toBe(false);
    expect(c.observedShards).toEqual([]);
  });

  it("treats an OS expecting 0 shards as not dispatched, not as a shortfall", () => {
    const root = mkdtempSync(join(tmpdir(), "shardc-"));
    for (const i of [1, 2]) shardDir(root, "macos", i, [`fx-${i}`]);
    const { code } = runMerge(root, "macos=2,linux=0,windows=0");
    expect(code).toBe(0);
  });

  it("skips the check entirely when --expect is absent, so a local run is unaffected", () => {
    // A local or unsharded run has no matrix size to compare against. Guessing
    // one from the observed shards would make the check vacuous — it would
    // always pass — so it is skipped and said to be skipped (`complete: null`).
    const root = mkdtempSync(join(tmpdir(), "shardc-"));
    for (const i of [1, 3]) shardDir(root, "macos", i, [`fx-${i}`]);
    const { code } = runMerge(root);
    expect(code).toBe(0);
    const c = JSON.parse(readFileSync(join(root, "shard-completeness-macos.json"), "utf-8"));
    expect(c.complete).toBeNull();
    expect(c.expectedShards).toBeNull();
  });
});
