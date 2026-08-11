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
import { environmentConflicts, mergeShards, sliceOf } from "../scripts/merge-font-conformance-shards.mjs";
import { comparability, oracleMovement, stackDelta } from "../scripts/diff-font-conformance-baseline.mjs";

const report = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  meta: {
    platform: "linux", arch: "x64", node: "v22.21.0", unicode: "16.0", icu: "76.1",
    stacksFile: "tools/font-conformance-stacks.linux.json",
    stackCorpusGeneratedAt: "2026-07-29T23:19:22.108Z",
    stackCorpusPlatform: "linux",
    codepoints: 292466, stacks: 1, includePua: true, ranges: null, sampleByte: null, strictAlias: false, lang: "en",
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
      .toEqual({ codepoints: 5, stacks: 2, includePua: false, ranges: [[0, 9]], sampleByte: null, strictAlias: true, lang: "ja" });
  });
});

describe("comparability", () => {
  const meta = {
    image: "playwright-v1.59.1-noble-x64",
    chromium: "147.0.7727.15",
    unicode: "16.0",
    corpus: { generatedAt: "2026-07-29T23:19:22.108Z" },
    fontInventory: { digest: "abc123" },
    slice: { codepoints: 292466, stacks: 6, includePua: true, ranges: null, sampleByte: null, strictAlias: false, lang: "en" },
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

  it("refuses a run whose BROWSER changed, even at the same runner image", () => {
    // The whole Chrome side of every comparison comes out of this build, so a
    // baseline captured under a different one is not a baseline for this run.
    //
    // Not hypothetical: `font-variant-emoji: emoji` moves U+00A9 / U+2122 /
    // U+203C / U+263A to the colour font in 147.0.7727.15 and leaves them on
    // the primary in 148.0.7778.96 — measured on ONE host with the platform
    // held constant, after that difference had read as Windows-specific for a
    // week. Every other field here matched throughout.
    const r = comparability({ ...meta, chromium: "148.0.7778.96" }, meta);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatch(/Chromium/);
  });

  it("refuses a run whose installed fonts changed", () => {
    expect(comparability({ ...meta, fontInventory: { digest: "def456" } }, meta)[0]).toMatch(/font inventory/);
  });

  it("refuses a run that swept a different slice", () => {
    expect(comparability({ ...meta, slice: { ...meta.slice, stacks: 12 } }, meta)[0]).toMatch(/slice\.stacks/);
    const byteZero = { ...meta, slice: { ...meta.slice, sampleByte: 0 } };
    expect(comparability({ ...meta, slice: { ...meta.slice, sampleByte: 1 } }, byteZero)[0]).toMatch(/slice\.sampleByte/);
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

/**
 * DM-1898: a run's shards are separate CI jobs on separate runners, so "the run's
 * environment" is only well-defined if they agree.
 *
 * They demonstrably can't be assumed to. Measured on the visual sweep: two runs
 * of one commit 15 minutes apart, and in the first of them shard 5 of 5 executed
 * on runner image 20260720.0258 (macOS 26.4) while shards 1-4 were on
 * 20260728.0273 (macOS 26.5.2) — `macos-latest` mid-rollout. Chrome's fallback
 * differs between those, which is a font-selection change, i.e. exactly what this
 * oracle measures.
 *
 * Before this, `mergeShards` took `meta` from the first non-null report and the
 * image / inventory from the first shard directory that had the file, on the
 * stated assumption that shards "differ only in WHICH slice they swept". These
 * pin the two halves of the fix: notice the disagreement, and refuse to grade or
 * enshrine a run that has one.
 */
describe("environment agreement across shards (DM-1898)", () => {
  const shard = (name: string, over: Record<string, unknown> = {}, env: unknown = undefined) => ({
    name,
    report: report({ meta: { ...(report().meta as object), ...over } }),
    ...(env === undefined ? {} : { env }),
  });

  it("reports no conflict when every shard agrees", () => {
    expect(environmentConflicts([shard("s1"), shard("s2"), shard("s3")])).toEqual([]);
  });

  it("catches an ICU split — the one that changes the codepoint DENOMINATOR", () => {
    // `meta.icu` decides which codepoints exist at all, so the merged totals of a
    // run whose shards disagree on it are quoted against two different universes.
    const conflicts = environmentConflicts([
      shard("s1"), shard("s2"), shard("s3", { icu: "77.1" }),
    ]);
    const icu = conflicts.find((c) => c.field === "ICU version");
    expect(icu).toBeDefined();
    expect(icu!.values[0]).toEqual({ value: "76.1", shards: ["s1", "s2"] });
    expect(icu!.values[1]).toEqual({ value: "77.1", shards: ["s3"] });
  });

  it("catches a font-inventory split, which is the semantic ground truth here", () => {
    const conflicts = environmentConflicts([
      shard("s1", {}, { image: "macos26-arm64", fontInventory: { digest: "aaaa" } }),
      shard("s2", {}, { image: "macos26-arm64", fontInventory: { digest: "bbbb" } }),
    ]);
    expect(conflicts.map((c) => c.field)).toEqual(["font inventory digest"]);
  });

  it("catches shards that accidentally mixed rotating sample buckets", () => {
    const conflicts = environmentConflicts([
      shard("s1", { sampleByte: 0x00 }),
      shard("s2", { sampleByte: 0x01 }),
    ]);
    expect(conflicts.map((c) => c.field)).toContain("sample low byte");
  });

  it("ignores a field absent on one shard rather than crying wolf", () => {
    // An older shard artifact predates a field. That is "cannot tell", not
    // "different" — and a warning that fires spuriously gets ignored.
    expect(environmentConflicts([
      shard("s1", {}, { image: "macos26-arm64", fontInventory: { digest: "aaaa" } }),
      shard("s2", {}, { image: null, fontInventory: null }),
    ])).toEqual([]);
  });

  it("skips shards whose report is missing entirely", () => {
    expect(environmentConflicts([shard("s1"), { name: "s2", report: null }])).toEqual([]);
  });

  it("mergeShards records the conflicts on the merged doc", () => {
    const doc = mergeShards([shard("s1"), shard("s2", { unicode: "17.0" })]);
    expect(doc.meta.envConflicts.map((c: { field: string }) => c.field)).toContain("Unicode version");
  });

  it("comparability REFUSES a blended run even though every meta field matches", () => {
    // The load-bearing case. A blend presents one shard's environment, so the
    // field-by-field checks below it all pass — the guard has to look at the
    // conflict list, not at the fields.
    const clean = report().meta as Record<string, unknown>;
    const blended = {
      ...clean,
      envConflicts: [{ field: "ICU version", values: [
        { value: "76.1", shards: ["s1"] }, { value: "77.1", shards: ["s2"] },
      ] }],
    };
    expect(comparability(clean, clean)).toEqual([]);           // identical, comparable
    const reasons = comparability(blended, clean);
    expect(reasons.join(" ")).toMatch(/run's shards disagree on ICU version/);
    expect(reasons.join(" ")).toContain("s2");
  });

  it("comparability also refuses when the BASELINE was a blend", () => {
    const clean = report().meta as Record<string, unknown>;
    const blended = { ...clean, envConflicts: [{ field: "runner image", values: [
      { value: "a", shards: ["s1"] }, { value: "b", shards: ["s2"] },
    ] }] };
    expect(comparability(clean, blended).join(" ")).toMatch(/baseline's shards disagree/);
  });

  it("an empty conflict list is not treated as a conflict", () => {
    const clean = { ...(report().meta as object), envConflicts: [] };
    expect(comparability(clean, clean)).toEqual([]);
  });
});

/**
 * DM-1903: telling "our answer changed" apart from "Chrome's answer changed".
 *
 * A mismatch delta is the distance between two answers, so it moves when either
 * side does, and the report could not say which. Measured cost: two runs of ONE
 * commit differed by +108,464 because Chrome flipped `sans-serif` from
 * Helvetica-Bold to Arial-BoldMT; a third run on the same commit reproduced the
 * baseline to the row. Separately, a 60-row swing on the same instrument was
 * credited to a cache fix that had nothing to do with it — Chrome had simply
 * stopped answering `.PingFangHK-Regular` for those codepoints.
 *
 * `chromeFaces` tallies only `primaryChromeFace(...)`, so nothing our resolver
 * does contributes to it. Any movement in it is oracle drift by construction,
 * which is what makes it the right signal — and why the face NAME list could
 * not serve: across those two runs it was byte-identical (291 faces both times),
 * because every face involved was already in use on some other stack.
 */
describe("oracle movement (DM-1903)", () => {
  it("reports nothing when Chrome answered identically", () => {
    const r = oracleMovement({ "Helvetica-Bold": 100, "Arial-BoldMT": 5 }, { "Helvetica-Bold": 100, "Arial-BoldMT": 5 });
    expect(r).toEqual({ comparable: true, total: 0, moved: [] });
  });

  it("CATCHES the real sans-serif flip, which the name list could not", () => {
    // Real counts from the two runs. Both faces appear on both sides, so the
    // set of names is unchanged — only the distribution moved.
    const before = { "Helvetica-Bold": 222883, "Arial-BoldMT": 110 };
    const after = { "Helvetica-Bold": 114417, "Arial-BoldMT": 108576 };
    expect(Object.keys(before).sort()).toEqual(Object.keys(after).sort());   // name list: blind
    const r = oracleMovement(after, before);
    expect(r.comparable).toBe(true);
    expect(r.total).toBe(108466 + 108466);   // |−108,466| + |+108,466|
    expect(r.moved[0].face).toBe("Helvetica-Bold");
    expect(r.moved[0].delta).toBe(-108466);
  });

  it("catches the small drift that was mis-credited to a code fix", () => {
    // -60 on .PingFangHK-Regular is exactly the 44 + 16 of the two routes that
    // vanished, and it is on CHROME's side of the comparison.
    const r = oracleMovement(
      { ".PingFangHK-Regular": 4565, "HiraMinProN-W3": 1236 },
      { ".PingFangHK-Regular": 4625, "HiraMinProN-W3": 1164 },
    );
    expect(r.moved.find((m) => m.face === ".PingFangHK-Regular")?.delta).toBe(-60);
    expect(r.total).toBe(60 + 72);
  });

  it("counts a face that appears or disappears entirely", () => {
    expect(oracleMovement({ A: 10 }, {}).moved).toEqual([{ face: "A", delta: 10 }]);
    expect(oracleMovement({}, { A: 10 }).moved).toEqual([{ face: "A", delta: -10 }]);
  });

  it("sorts by magnitude, so the dominant flip leads the report", () => {
    const r = oracleMovement({ A: 100, B: 2, C: 30 }, { A: 1, B: 1, C: 1 });
    expect(r.moved.map((m) => m.face)).toEqual(["A", "C", "B"]);
  });

  it("says CANNOT TELL for a baseline that predates the field, not zero", () => {
    // "did not move" and "cannot tell" are different answers, and only the
    // first licenses a verdict. A fabricated zero here would restore exactly the
    // false confidence this exists to remove.
    expect(oracleMovement({ A: 1 }, undefined).comparable).toBe(false);
    expect(oracleMovement({ A: 1 }, null).comparable).toBe(false);
    expect(oracleMovement(undefined, { A: 1 }).comparable).toBe(false);
  });
});
