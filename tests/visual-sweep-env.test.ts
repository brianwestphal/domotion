/**
 * The environment guard for the visual sweep.
 *
 * Why it exists, in one measurement: two macOS unicode sweeps of the IDENTICAL
 * commit disagreed on exactly one fixture of 818, by 4x
 * (`2070-209F-superscripts-and-subscripts`, 0.0574 vs 0.0138). It was attributed
 * to five successive unrelated code changes, three of those readings wrong,
 * because nothing recorded said the two runs were different measurements.
 *
 * They were. `macos-latest` was mid-rollout: the shard carrying that fixture ran
 * on runner image `20260720.0258` (macOS 26.4, kernel 25.4.0) in one run and
 * `20260728.0273` (macOS 26.5.2, kernel 25.5.0) in the other, and Chrome's
 * per-codepoint fallback for U+2090-U+2093 differs between them. Both the
 * expected AND actual PNGs moved (688 px / 327 px, at full glyph contrast).
 *
 * The pre-existing `meta.image` check was structurally incapable of seeing it —
 * it derives from `ImageOS`, which reads `macOS26` on both images. So these
 * tests pin the two things that were missing rather than the check that existed:
 *
 *  - a run's environment is compared on fields that actually MOVE
 *    (`ImageVersion`, `os.release()`, the installed-font digest);
 *  - a single run whose SHARDS straddled the rotation is reported as
 *    heterogeneous instead of silently blending into one baseline.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { computeRunEnv, envComparability, mergeShardEnvs } from "../scripts/run-env.mjs";

/** The two real macOS runner environments, as observed in the two CI runs. */
const MACOS_26_4 = computeRunEnv({
  image: "macos26-arm64", imageVersion: "20260720.0258", osRelease: "25.4.0",
  platform: "darwin", arch: "arm64", node: "v22.21.0",
  fontInventory: { digest: "a8a5b567b046c5c5", count: 370 },
});
const MACOS_26_5 = computeRunEnv({
  image: "macos26-arm64", imageVersion: "20260728.0273", osRelease: "25.5.0",
  platform: "darwin", arch: "arm64", node: "v22.21.0",
  fontInventory: { digest: "a8a5b567b046c5c5", count: 370 },
});

describe("computeRunEnv", () => {
  it("normalizes absent and blank fields to null rather than empty strings", () => {
    // A blank string would compare unequal to a missing one and produce a
    // spurious "environment changed" banner, training readers to ignore it.
    const e = computeRunEnv({ image: "  ", imageVersion: undefined, osRelease: "25.5.0" });
    expect(e.image).toBeNull();
    expect(e.imageVersion).toBeNull();
    expect(e.osRelease).toBe("25.5.0");
    expect(e.fontInventory).toBeNull();
  });

  it("keeps a numeric font count but nulls a non-numeric one", () => {
    expect(computeRunEnv({ fontInventory: { digest: "abc", count: 370 } }).fontInventory)
      .toEqual({ digest: "abc", count: 370, entries: null });
    expect(computeRunEnv({ fontInventory: { digest: "abc", count: "370" as unknown as number } }).fontInventory)
      .toEqual({ digest: "abc", count: null, entries: null });
  });

  it("carries the font list, not just its digest", () => {
    // The digest says the font set CHANGED; only the list says what is in it.
    // Investigating a fixture that flipped between two faces stalled precisely
    // here — the recorded inventory could not answer "does this runner even
    // have the face that would produce that glyph", so the only way to find out
    // was to spend another CI run.
    const inv = computeRunEnv({ fontInventory: { digest: "abc", count: 2, entries: ["Helvetica.ttc", "SFNS.ttf"] } }).fontInventory;
    expect(inv).toEqual({ digest: "abc", count: 2, entries: ["Helvetica.ttc", "SFNS.ttf"] });
  });

  it("nulls a non-array entries rather than coercing it", () => {
    // Same convention as every other field: absent reads as "cannot tell".
    // A record written before this field existed must not read as "no fonts".
    expect(computeRunEnv({ fontInventory: { digest: "abc", count: 1, entries: "Helvetica.ttc" as unknown as string[] } }).fontInventory?.entries)
      .toBeNull();
  });
});

describe("envComparability", () => {
  it("DETECTS the real rotation that meta.image could not see", () => {
    // The regression pin. `image` is identical on both sides — that is exactly
    // why the existing check passed while Chrome painted different glyphs.
    expect(MACOS_26_4.image).toBe(MACOS_26_5.image);
    const reasons = envComparability(MACOS_26_4, MACOS_26_5);
    expect(reasons.join(" ")).toMatch(/runner image version/);
    expect(reasons.join(" ")).toMatch(/OS release/);
    expect(reasons.join(" ")).toContain("20260720.0258");
    expect(reasons.join(" ")).toContain("25.4.0");
  });

  it("reports nothing for two runs on the same environment", () => {
    expect(envComparability(MACOS_26_5, MACOS_26_5)).toEqual([]);
  });

  it("flags a font-inventory change even when every other field matches", () => {
    // The semantic ground truth: font selection is what a sweep measures, so an
    // image that keeps its version but rotates fonts must still be caught.
    const rotated = computeRunEnv({ ...MACOS_26_5, fontInventory: { digest: "ffffffffffffffff", count: 372 } });
    expect(envComparability(rotated, MACOS_26_5)).toEqual([
      expect.stringContaining("font inventory digest"),
    ]);
  });

  it("skips a field absent on either side instead of calling it a difference", () => {
    // An older baseline predates this record entirely. Reporting "everything
    // changed" for it is the fastest way to make the warning ignorable.
    const partial = computeRunEnv({ image: "macos26-arm64" });
    expect(envComparability(partial, MACOS_26_5)).toEqual([]);
    expect(envComparability(MACOS_26_5, partial)).toEqual([]);
  });

  it("returns no reasons when either side is missing entirely", () => {
    expect(envComparability(null, MACOS_26_5)).toEqual([]);
    expect(envComparability(MACOS_26_5, null)).toEqual([]);
  });
});

describe("mergeShardEnvs", () => {
  it("folds agreeing shards into one record", () => {
    const { combined, heterogeneous, conflicts } = mergeShardEnvs(
      [1, 2, 3, 4, 5].map((shard) => ({ shard, env: MACOS_26_5 })),
    );
    expect(heterogeneous).toBe(false);
    expect(conflicts).toEqual([]);
    expect(combined.osRelease).toBe("25.5.0");
    expect(combined.imageVersion).toBe("20260728.0273");
    expect(combined.fontInventory?.digest).toBe("a8a5b567b046c5c5");
  });

  it("REPORTS the real intra-run split — shard 5 on a different macOS than 1-4", () => {
    // This is what actually happened, and the half a baseline-vs-run check
    // cannot provide: the disagreement was INSIDE one sweep.
    const { combined, heterogeneous, conflicts } = mergeShardEnvs([
      { shard: 1, env: MACOS_26_5 }, { shard: 2, env: MACOS_26_5 },
      { shard: 3, env: MACOS_26_5 }, { shard: 4, env: MACOS_26_5 },
      { shard: 5, env: MACOS_26_4 },
    ]);
    expect(heterogeneous).toBe(true);

    const os = conflicts.find((c) => c.field === "OS release");
    expect(os).toBeDefined();
    // Majority first, and the minority names the shard to go look at.
    expect(os!.values[0]).toEqual({ value: "25.5.0", shards: [1, 2, 3, 4] });
    expect(os!.values[1]).toEqual({ value: "25.4.0", shards: [5] });

    // The combined record must NOT silently adopt the majority (or the first)
    // value: there is no single environment, and claiming one is precisely how
    // a blended run gets captured as a clean baseline.
    expect(combined.osRelease).toBeNull();
    expect(combined.imageVersion).toBeNull();
    // Fields the shards DO agree on still fold normally.
    expect(combined.image).toBe("macos26-arm64");
    expect(combined.arch).toBe("arm64");
  });

  it("does not treat a shared value as agreement when only one shard reported it", () => {
    const { combined, heterogeneous } = mergeShardEnvs([{ shard: 1, env: MACOS_26_5 }]);
    expect(heterogeneous).toBe(false);
    expect(combined.osRelease).toBe("25.5.0");
  });

  it("handles no shards, and shards with no env, without inventing one", () => {
    expect(mergeShardEnvs([]).heterogeneous).toBe(false);
    expect(mergeShardEnvs([]).combined.osRelease).toBeNull();
    expect(mergeShardEnvs([{ shard: 1, env: null as never }]).combined.image).toBeNull();
    expect(mergeShardEnvs(undefined as never).heterogeneous).toBe(false);
  });

  it("ignores a null field on one shard rather than calling it a conflict", () => {
    // A shard whose font probe failed records null. That is "cannot tell", not
    // "different" — degrading to a conflict would cry wolf on a flaky probe.
    const noFonts = computeRunEnv({ ...MACOS_26_5, fontInventory: null });
    const { heterogeneous, combined } = mergeShardEnvs([
      { shard: 1, env: MACOS_26_5 }, { shard: 2, env: noFonts },
    ]);
    expect(heterogeneous).toBe(false);
    expect(combined.fontInventory?.digest).toBe("a8a5b567b046c5c5");
  });
});

/**
 * End-to-end through the real scripts, on a synthetic shard tree shaped like the
 * run that caused this: five shards, one of them on a different macOS.
 *
 * The pure-function tests above can pass while the wiring is wrong (the env
 * never written, never read, never reaching the report), which is the failure
 * mode that let the original defect run for five attributions. So this drives
 * `merge-shard-results.mjs` -> `write-baseline.mjs` -> `diff-against-baseline.mjs`
 * as the workflow does, and asserts the warnings actually reach the Markdown.
 */
describe("shard tree -> merge -> baseline -> diff (end to end)", () => {
  const run = (script: string, args: string[]) =>
    execFileSync("node", [script, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

  /** Lay out `<dir>/results-macos-shard<i>/{results.json,run-env.json}`. */
  function tree(dir: string, envPerShard: Record<number, unknown>, fixtures: Record<string, number>) {
    for (const [shard, env] of Object.entries(envPerShard)) {
      const d = join(dir, `results-macos-shard${shard}`);
      mkdirSync(d, { recursive: true });
      const mine = Object.entries(fixtures).filter((_, i) => i % Object.keys(envPerShard).length === Number(shard) - 1);
      writeFileSync(join(d, "results.json"), JSON.stringify(
        mine.map(([name, diffPct]) => ({ name, pass: true, skipped: false, diffPct, worstTilePct: 0, regionCount: 0 })),
      ));
      writeFileSync(join(d, "run-env.json"), JSON.stringify(env));
    }
  }

  const FIXTURES = { "0000-basic-latin": 0.028, "2070-209F-superscripts-and-subscripts": 0.0138 };

  it("warns loudly when one shard straddled a runner-image rotation", () => {
    const dir = mkdtempSync(join(tmpdir(), "dm1897-het-"));
    tree(dir, { 1: MACOS_26_5, 2: MACOS_26_4 }, FIXTURES);
    const out = run("scripts/merge-shard-results.mjs", ["--input", dir, "--out", dir, "--summary", join(dir, "s.md")]);
    const md = readFileSync(join(dir, "s.md"), "utf8");

    expect(md).toContain("shards did NOT all run on the same environment");
    expect(md).toContain("OS release");
    expect(md).toContain("25.4.0");
    expect(out + md).toBeTruthy();

    // The combined record must refuse to name one OS, so a later baseline
    // capture cannot inherit the blend as though it were a clean measurement.
    const combined = JSON.parse(readFileSync(join(dir, "run-env-macos.json"), "utf8"));
    expect(combined.osRelease).toBeNull();
    expect(combined.image).toBe("macos26-arm64"); // still agreed on

    rmSync(dir, { recursive: true, force: true });
  });

  it("--strict-env exits non-zero on a blended run, while a clean run passes", () => {
    const bad = mkdtempSync(join(tmpdir(), "dm1897-strict-"));
    tree(bad, { 1: MACOS_26_5, 2: MACOS_26_4 }, FIXTURES);
    expect(() => run("scripts/merge-shard-results.mjs", ["--input", bad, "--out", bad, "--strict-env"])).toThrow();

    const good = mkdtempSync(join(tmpdir(), "dm1897-strict-ok-"));
    tree(good, { 1: MACOS_26_5, 2: MACOS_26_5 }, FIXTURES);
    expect(() => run("scripts/merge-shard-results.mjs", ["--input", good, "--out", good, "--strict-env"])).not.toThrow();

    rmSync(bad, { recursive: true, force: true });
    rmSync(good, { recursive: true, force: true });
  });

  it("the baseline diff leads with the environment change, not with the numbers", () => {
    // A baseline captured on 26.5, a run measured on 26.4 — the exact shape of
    // the comparison that produced five wrong attributions.
    const dir = mkdtempSync(join(tmpdir(), "dm1897-e2e-"));
    tree(dir, { 1: MACOS_26_5, 2: MACOS_26_5 }, FIXTURES);
    run("scripts/merge-shard-results.mjs", ["--input", dir, "--out", dir, "--summary", join(dir, "m.md")]);
    const basePath = join(dir, "baseline.json");
    run("scripts/write-baseline.mjs", ["--results", join(dir, "results-macos.json"), "--out", basePath,
      "--suite", "unicode", "--os", "macos", "--env", join(dir, "run-env-macos.json")]);

    // The baseline really did record the environment — without this the check
    // below would pass for the wrong reason.
    expect(JSON.parse(readFileSync(basePath, "utf8")).meta.env.osRelease).toBe("25.5.0");

    const otherEnv = join(dir, "other-env.json");
    writeFileSync(otherEnv, JSON.stringify(MACOS_26_4));
    run("scripts/diff-against-baseline.mjs", ["--results", join(dir, "results-macos.json"),
      "--baseline", basePath, "--env", otherEnv, "--summary", join(dir, "d.md")]);
    const md = readFileSync(join(dir, "d.md"), "utf8");

    expect(md).toContain("measured in a DIFFERENT environment");
    expect(md).toContain("25.4.0");
    // …and it must appear ABOVE the pass/fail counts, since it changes what
    // those counts mean.
    expect(md.indexOf("DIFFERENT environment")).toBeLessThan(md.indexOf("failing now"));

    rmSync(dir, { recursive: true, force: true });
  });

  it("says so plainly when the baseline predates environment recording", () => {
    const dir = mkdtempSync(join(tmpdir(), "dm1897-old-"));
    tree(dir, { 1: MACOS_26_5 }, FIXTURES);
    run("scripts/merge-shard-results.mjs", ["--input", dir, "--out", dir]);
    const basePath = join(dir, "old-baseline.json");
    // No --env: an older baseline, exactly like every one committed today.
    run("scripts/write-baseline.mjs", ["--results", join(dir, "results-macos.json"), "--out", basePath,
      "--suite", "unicode", "--os", "macos"]);
    run("scripts/diff-against-baseline.mjs", ["--results", join(dir, "results-macos.json"),
      "--baseline", basePath, "--env", join(dir, "run-env-macos.json"), "--summary", join(dir, "d.md")]);

    const md = readFileSync(join(dir, "d.md"), "utf8");
    expect(md).toContain("predates environment recording");
    expect(md).not.toContain("DIFFERENT environment"); // not a false alarm

    rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * DM-1911: `--update-baseline` wrote a baseline with `env: null` and said
 * nothing. The cause was upstream (the slim metadata artifact did not carry
 * `run-env-<os>.json`), but the reason it went unnoticed is that writing a
 * provenance-less baseline was *allowed* — and the result is indistinguishable
 * from a baseline captured before the guard existed, so it reads as merely old
 * rather than as the guard having been removed.
 *
 * These pin the refusal itself, since that is the part that has to hold however
 * the artifact plumbing changes.
 */
describe("ci-baseline-aggregate refuses to write a baseline without provenance", () => {
  const repoRoot = join(import.meta.dirname, "..");
  // `write-baseline.mjs` wants the MERGED shape: a bare array of fixture rows.
  const RESULTS = [{ name: "f", diffPct: 0, worstTilePct: 0, regionCount: 0, pass: true }];

  const run = (dir: string) => {
    try {
      execFileSync("node", ["scripts/ci-baseline-aggregate.mjs",
        "--input", dir, "--suite", "html", "--out", dir, "--update-baseline"],
        { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
      return { code: 0, err: "" };
    } catch (e: unknown) {
      const x = e as { status?: number; stderr?: string };
      return { code: x.status ?? -1, err: x.stderr ?? "" };
    }
  };

  it("exits non-zero and names the missing file when run-env is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "dm1911-"));
    try {
      writeFileSync(join(dir, "results-macos.json"), JSON.stringify(RESULTS));
      const { code, err } = run(dir);
      expect(code).not.toBe(0);
      expect(err).toContain("run-env-macos.json");
      // ...and must not have left a baseline behind.
      expect(() => readFileSync(join(dir, "baseline-html-macos.json"), "utf-8")).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  // The positive case is asserted against `write-baseline.mjs` directly rather
  // than through the aggregate, because the aggregate diffs FIRST and that step
  // legitimately refuses to judge a synthetic run against the real committed
  // baseline (mismatched environment — which is the comparator working). What
  // needs pinning here is that provenance reaches the written file.
  it("writes meta.env through when run-env IS present", () => {
    const dir = mkdtempSync(join(tmpdir(), "dm1911-"));
    try {
      writeFileSync(join(dir, "results-macos.json"), JSON.stringify(RESULTS));
      writeFileSync(join(dir, "run-env-macos.json"),
        JSON.stringify({ image: "macos26-arm64", platform: "darwin", arch: "arm64", node: "v22.21.0" }));
      execFileSync("node", ["scripts/write-baseline.mjs",
        "--results", join(dir, "results-macos.json"), "--out", join(dir, "b.json"),
        "--suite", "html", "--os", "macos", "--env", join(dir, "run-env-macos.json")],
        { cwd: repoRoot, stdio: "pipe" });
      const written = JSON.parse(readFileSync(join(dir, "b.json"), "utf-8"));
      expect(written.meta.env).not.toBeNull();
      expect(written.meta.env.image).toBe("macos26-arm64");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
