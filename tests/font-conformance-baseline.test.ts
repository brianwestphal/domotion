/**
 * Unit coverage for the per-platform font-conformance baseline machinery:
 * merging shard reports (`scripts/merge-font-conformance-shards.mjs`) and
 * judging a merged run against a committed baseline
 * (`scripts/diff-font-conformance-baseline.mjs`).
 *
 * Both exist to stop a sweep from PASSING for the wrong reason. The two failure
 * modes pinned here are the ones that have actually happened in this area:
 *
 *  - a shard dies, its report is absent, and summing the survivors produces a
 *    smaller mismatch total that reads like an improvement;
 *  - the environment moves underneath the baseline (a runner image rotation, a
 *    different ICU codepoint universe, a different slice) and the two numbers
 *    are compared anyway, yielding a confident verdict about nothing.
 */
import { describe, expect, it } from "vitest";
import { mergeShards, sliceOf } from "../scripts/merge-font-conformance-shards.mjs";
import { comparability, stackDelta } from "../scripts/diff-font-conformance-baseline.mjs";

const report = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  meta: {
    platform: "linux", arch: "x64", node: "v22.21.0", unicode: "16.0", icu: "76.1",
    stacksFile: "tools/font-conformance-stacks.linux.json",
    stackCorpusGeneratedAt: "2026-07-29T23:19:22.108Z",
    stackCorpusPlatform: "linux",
    codepoints: 292466, stacks: 1, includePua: true, ranges: null, strictAlias: false, lang: "en",
  },
  summary: { comparisons: 100, mismatchTotal: 10, "agree-exact": 90 },
  mismatchesByStack: [{ stack: "Times", count: 10 }],
  topMismatchPairs: [{ pair: "A → B", count: 10 }],
  chromeFaces: [{ face: "LiberationSerif", count: 90 }],
  ...over,
});

describe("mergeShards", () => {
  // DM-1887: with a 2-D matrix (stack shards x codepoint shards) the two axes
  // must be folded DIFFERENTLY, and either mistake yields a slice that looks
  // comparable to a baseline and is not — which the comparator would then judge
  // against, since it compares slices rather than refusing on them.
  //
  //   stacks are PARTITIONED along the stack axis and RE-SWEPT by every cp shard
  //   codepoints are PARTITIONED along the cp axis and RE-SWEPT by every stack shard
  //
  // So summing every report double-counts stacks by the cp-shard factor, and
  // taking one report's codepoints understates the universe by the same factor.
  const shard2d = (si: number, ci: number, stacks: number, cps: number) => ({
    name: `s${si}c${ci}`,
    report: {
      meta: { stacks, codepoints: cps, stackShard: [si, 2], shard: [ci, 3] },
      summary: { mismatchTotal: 10 },
    },
  });

  it("folds a 2-D matrix without double-counting either axis", () => {
    const shards = [];
    for (let si = 1; si <= 2; si++) for (let ci = 1; ci <= 3; ci++) shards.push(shard2d(si, ci, 3, 100));
    const m = mergeShards(shards as never, { expected: 6 });
    // 2 stack shards x 3 stacks each. NOT 18 (which is what summing all six gives).
    expect(m.meta.slice.stacks).toBe(6);
    // 3 cp shards x 100 codepoints. NOT 100 (one report's value).
    expect(m.meta.slice.codepoints).toBe(300);
    // Row counts DO sum over every report — each swept a disjoint (stack, cp) cell.
    expect(m.summary.mismatchTotal).toBe(60);
    expect(m.meta.complete).toBe(true);
  });

  it("leaves a stack-only run's accounting exactly as before", () => {
    // The shipped shape: `shard` is null because the shard script omits
    // `--shard` unless cp_shards > 1. Codepoints must be the full universe.
    const shards = [1, 2, 3].map((si) => ({
      name: `s${si}`,
      report: { meta: { stacks: 2, codepoints: 292466, stackShard: [si, 3], shard: null }, summary: {} },
    }));
    const m = mergeShards(shards as never, { expected: 3 });
    expect(m.meta.slice.stacks).toBe(6);
    expect(m.meta.slice.codepoints).toBe(292466);
  });

  it("folds a codepoint-only run, the mirror case", () => {
    const shards = [1, 2].map((ci) => ({
      name: `c${ci}`,
      report: { meta: { stacks: 6, codepoints: 150, stackShard: null, shard: [ci, 2] }, summary: {} },
    }));
    const m = mergeShards(shards as never, { expected: 2 });
    expect(m.meta.slice.stacks).toBe(6);
    expect(m.meta.slice.codepoints).toBe(300);
  });

  it("still withholds the verdict when a 2-D shard is missing", () => {
    // The shard-loss guard has to survive the bigger matrix: 30 jobs is 30
    // chances to lose one, and a smaller denominator reads as fewer mismatches.
    const shards = [shard2d(1, 1, 3, 100), { name: "s1c2", report: null }];
    const m = mergeShards(shards as never, { expected: 6 });
    expect(m.meta.complete).toBe(false);
    expect(m.meta.missingShards).toContain("s1c2");
  });

  it("sums the numeric summary fields across shards", () => {
    const m = mergeShards([
      { name: "s1", report: report() },
      { name: "s2", report: report() },
    ], { os: "linux", expected: 2 });
    expect(m.summary.comparisons).toBe(200);
    expect(m.summary.mismatchTotal).toBe(20);
    expect(m.byStack).toEqual({ Times: 20 });
    expect(m.byPair).toEqual({ "A → B": 20 });
    expect(m.chromeFaces).toEqual({ LiberationSerif: 180 });
    expect(m.meta.complete).toBe(true);
  });

  it("counts distinct routes as a SET, not as a sum", () => {
    // Two shards that each hit the same route must not report two routes: the
    // route count measures how many decisions are wrong, and double-counting it
    // makes a single defect look like several.
    const m = mergeShards([
      { name: "s1", report: report() },
      { name: "s2", report: report({ topMismatchPairs: [{ pair: "A → B", count: 4 }, { pair: "C → D", count: 1 }] }) },
    ], { expected: 2 });
    expect(m.summary.distinctMismatchPairs).toBe(2);
  });

  it("records an absent shard rather than silently merging the survivors", () => {
    const m = mergeShards([
      { name: "s1", report: report() },
      { name: "s2", report: null },
    ], { expected: 2 });
    expect(m.meta.missingShards).toEqual(["s2"]);
    expect(m.meta.shardsMerged).toBe(1);
    expect(m.meta.complete).toBe(false);
    // The total IS the survivors' — which is exactly why `complete: false` has
    // to travel with it.
    expect(m.summary.mismatchTotal).toBe(10);
  });

  it("is incomplete when fewer shard artifacts arrived than were requested", () => {
    const m = mergeShards([{ name: "s1", report: report() }], { expected: 6 });
    expect(m.meta.complete).toBe(false);
    expect(m.meta.shardsExpected).toBe(6);
  });

  it("carries the corpus identity and the platform through to the merged meta", () => {
    const m = mergeShards([{ name: "s1", report: report() }], { expected: 1 });
    expect(m.meta.corpus).toEqual({
      file: "tools/font-conformance-stacks.linux.json",
      generatedAt: "2026-07-29T23:19:22.108Z",
      platform: "linux",
    });
    expect(m.meta.unicode).toBe("16.0");
  });
});

describe("sliceOf", () => {
  it("keeps exactly the fields that make two runs comparable", () => {
    expect(sliceOf({ codepoints: 5, stacks: 2, includePua: false, ranges: [[0, 9]], strictAlias: true, lang: "ja" }))
      .toEqual({ codepoints: 5, stacks: 2, includePua: false, ranges: [[0, 9]], strictAlias: true, lang: "ja" });
  });
});

describe("comparability", () => {
  const meta = {
    image: "playwright-v1.59.1-noble-x64",
    unicode: "16.0",
    corpus: { generatedAt: "2026-07-29T23:19:22.108Z" },
    fontInventory: { digest: "abc123" },
    slice: { codepoints: 292466, stacks: 6, includePua: true, strictAlias: false, lang: "en" },
  };

  it("accepts a run measured in the same environment over the same slice", () => {
    expect(comparability(meta, meta)).toEqual([]);
  });

  it("refuses a run whose runner image rotated", () => {
    const r = comparability({ ...meta, image: "playwright-v1.60.0-noble-x64" }, meta);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatch(/runner image/);
  });

  it("refuses a run whose ICU codepoint universe differs", () => {
    // Node's ICU decides which codepoints exist at all, so a bump changes the
    // denominator and the set of things asked about.
    expect(comparability({ ...meta, unicode: "17.0" }, meta)[0]).toMatch(/Unicode/);
  });

  it("refuses a run whose installed fonts changed", () => {
    expect(comparability({ ...meta, fontInventory: { digest: "def456" } }, meta)[0]).toMatch(/font inventory/);
  });

  it("refuses a run that swept a different slice", () => {
    expect(comparability({ ...meta, slice: { ...meta.slice, stacks: 12 } }, meta)[0]).toMatch(/slice\.stacks/);
  });

  it("stays silent about a field either side never recorded", () => {
    // An older baseline that predates a field must not be declared
    // incomparable for lacking it — that would fail every run until reseeded.
    expect(comparability(meta, { ...meta, fontInventory: undefined })).toEqual([]);
  });
});

describe("stackDelta", () => {
  it("separates worse, better, newly-disagreeing and resolved stacks", () => {
    const d = stackDelta({ a: 5, b: 1, c: 7 }, { a: 3, b: 4, d: 2 });
    expect(d.worse).toEqual([{ stack: "a", now: 5, base: 3 }]);
    expect(d.better).toEqual([{ stack: "b", now: 1, base: 4 }]);
    expect(d.added).toEqual([{ stack: "c", count: 7 }]);
    expect(d.removed).toEqual([{ stack: "d", count: 2 }]);
  });

  it("does not call an unchanged stack a movement", () => {
    const d = stackDelta({ a: 3 }, { a: 3 });
    expect(d.worse).toEqual([]);
    expect(d.better).toEqual([]);
  });

  it("treats a stack that fell to zero as resolved, not as a new disagreement", () => {
    const d = stackDelta({ a: 0 }, { a: 9 });
    expect(d.better).toEqual([{ stack: "a", now: 0, base: 9 }]);
    expect(d.added).toEqual([]);
  });
});
