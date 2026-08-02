// `diff-against-baseline.mjs` must refuse to grade a result set that is not
// describing the baseline's corpus.
//
// This is not hypothetical tidiness. Dispatching the unicode and html sweeps
// seconds apart made the client-side run lookup attach to the wrong run, and the
// unicode invocation then compared html results against the unicode baseline. It
// printed "Dropped (in baseline, not in this run): 818" — which reads as though
// the change had deleted the entire fixture corpus, not as though the tool had
// fetched the wrong artifact. The reverse pairing is the dangerous one: a clean
// verdict from the wrong run is indistinguishable from a real pass.
//
// The run lookup is fixed too (it now matches on suite and OS, not just ref and
// time), but this guard is the one that holds for any cause — a mis-staged
// artifact, a truncated download, a baseline for another suite.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(__dirname, "..", "scripts", "diff-against-baseline.mjs");

/** A results doc in the shape the sweeps emit. */
function doc(names: string[]): string {
  return JSON.stringify({
    meta: { os: "macos", suite: "test" },
    results: names.map((name) => ({ name, pass: true, skipped: false, diffPct: 0, worstTilePct: 0 })),
  });
}

function run(currentNames: string[], baselineNames: string[]): { status: number | null; err: string } {
  const dir = mkdtempSync(join(tmpdir(), "domotion-corpus-"));
  try {
    const r = join(dir, "results.json");
    const b = join(dir, "baseline.json");
    writeFileSync(r, doc(currentNames));
    writeFileSync(b, doc(baselineNames));
    const p = spawnSync(process.execPath, [SCRIPT, "--results", r, "--baseline", b], { encoding: "utf-8" });
    return { status: p.status, err: `${p.stderr}${p.stdout}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const seq = (prefix: string, n: number): string[] =>
  Array.from({ length: n }, (_, i) => `${prefix}-${String(i).padStart(4, "0")}`);

describe("the baseline comparator refuses a foreign corpus", () => {
  it("fails loudly when the two sets barely intersect", () => {
    // The real collision, in miniature: two corpora with nothing in common.
    // Non-zero exit is the assertion that matters — a warning printed above a
    // plausible-looking table would still be acted on.
    const { status, err } = run(seq("html", 60), seq("unicode", 100));
    expect(status).toBe(2);
    expect(err).toMatch(/does not describe the baseline's corpus/);
  });

  it("stays out of the way when a suite merely gained and lost fixtures", () => {
    // The control, and the reason the threshold is loose rather than exact.
    // Suites genuinely churn — fixtures get added, renamed and removed — so a
    // guard that fired on ordinary drift would be turned off within a week.
    const shared = seq("unicode", 90);
    const { status } = run([...shared, ...seq("added", 8)], [...shared, ...seq("removed", 10)]);
    expect(status).toBe(0);
  });

  it("does not fire on an empty side", () => {
    // An empty run is a different failure with its own reporting, and grading it
    // as a corpus mismatch would mislabel it.
    expect(run([], seq("unicode", 100)).status).toBe(0);
    expect(run(seq("unicode", 100), []).status).toBe(0);
  });
});
