import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The conformance oracle only measures what it claims to when the runner it
// runs on can ask the OS the same question Chrome asks. On macOS and Windows
// that means a native helper binary — gitignored, so a fresh CI checkout has
// none unless the job builds one. Without it `isGlyphHelperAvailable()` goes
// false and the resolver silently drops to the static fallback chain, which
// answers a DIFFERENT question than the workflow reports on: the run still
// produces a clean-looking number, for the wrong renderer.
//
// The failure mode is workflow drift, so — like the visual-sweep guard next
// door — this reads the workflow rather than the code.

const WORKFLOW = resolve(__dirname, "..", ".github", "workflows", "font-conformance.yml");

describe("font-conformance.yml sweeps all three platforms honestly", () => {
  const yaml = readFileSync(WORKFLOW, "utf-8");

  /** Split into job blocks by the 2-space-indented job keys. */
  const jobs = (() => {
    const out: Record<string, string> = {};
    let cur: string | null = null;
    let buf: string[] = [];
    for (const line of yaml.split("\n")) {
      const m = /^ {2}([a-zA-Z0-9_-]+):\s*$/.exec(line);
      if (m != null) {
        if (cur != null) out[cur] = buf.join("\n");
        cur = m[1];
        buf = [];
      } else if (cur != null) {
        buf.push(line);
      }
    }
    if (cur != null) out[cur] = buf.join("\n");
    return out;
  })();

  it("puts no `${{ … }}` expression inside a YAML flow mapping", () => {
    // `with: { pattern: font-conformance-${{ matrix.os }}-shard-* }` is not
    // valid YAML — the braces close the flow mapping early ("missed comma
    // between flow collection entries"). GitHub's response to an unparseable
    // workflow is not an error about the syntax: it reports that the workflow
    // "does not have a 'workflow_dispatch' trigger", because it could not read
    // one. That is a long way from the actual mistake, so it is pinned here.
    // Quoting it is the fix, so quoted segments are removed before looking.
    const bad = yaml
      .split("\n")
      .filter((l) => /^\s*\w[\w-]*:\s*\{/.test(l))
      .filter((l) => /\$\{\{/.test(l.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""')));
    expect(bad, `quote the expression or use a block mapping:\n${bad.join("\n")}`).toEqual([]);
  });

  it("parses the workflow into jobs (guard is not vacuous)", () => {
    expect(Object.keys(jobs)).toEqual(
      expect.arrayContaining(["setup", "sweep-macos", "sweep-linux", "sweep-windows", "aggregate"]),
    );
  });

  it("the macOS sweep builds the CoreText helper before sweeping", () => {
    const job = jobs["sweep-macos"];
    const build = job.indexOf("macos-glyph-extractor");
    const run = job.indexOf("ci-font-conformance-shard.sh");
    expect(build, "sweep-macos must build tools/macos-glyph-extractor").toBeGreaterThanOrEqual(0);
    expect(run).toBeGreaterThanOrEqual(0);
    expect(build, "the helper must exist before the sweep asks CoreText anything").toBeLessThan(run);
  });

  it("the Windows sweep builds the DirectWrite helper before sweeping", () => {
    const job = jobs["sweep-windows"];
    const build = job.indexOf("win32-glyph-extractor");
    const run = job.indexOf("ci-font-conformance-shard.sh");
    expect(build, "sweep-windows must build tools/win32-glyph-extractor").toBeGreaterThanOrEqual(0);
    expect(run).toBeGreaterThanOrEqual(0);
    expect(build).toBeLessThan(run);
  });

  it("the Linux sweep builds its helper too, before sweeping", () => {
    // INVERTED by DM-1886. This assertion previously said the opposite — that
    // Linux needs no helper because its resolver shells out to `fc-match` — and
    // was written specifically to stop someone "fixing" that asymmetry later.
    // The premise changed: the Linux resolver now asks the helper's `fcfallback`
    // query, which is Chrome's actual algorithm rather than an approximation of
    // it, so the build is now required for the same reason macOS and Windows
    // need theirs.
    //
    // The failure this guards is silent by construction: without the helper the
    // resolver DEGRADES to `fc-match` instead of erroring, so the sweep goes
    // green having measured a different algorithm — and a baseline captured
    // from it would bake the old answers in as ground truth. That happened: a
    // capture run sat at 14/19 after 117 minutes with every lagging job on
    // Linux, because this step did not exist.
    const job = jobs["sweep-linux"];
    const build = job.indexOf("linux-glyph-extractor");
    const run = job.indexOf("ci-font-conformance-shard.sh");
    expect(build, "sweep-linux must build tools/linux-glyph-extractor").toBeGreaterThanOrEqual(0);
    expect(build, "the helper must exist before the sweep asks fontconfig anything").toBeLessThan(run);
    // libfontconfig is what the `fcfallback` query links against; CMake requires
    // it, so a missing dev package fails the build rather than producing a
    // helper that answers "unknown query type" and degrades invisibly.
    expect(job).toMatch(/libfontconfig1-dev/);
  });

  it("Linux sweeps inside the pinned Playwright container, not a bare ubuntu image", () => {
    // The Linux fallback answer IS the container's fontconfig set, so a
    // different image is a different oracle — and would silently invalidate the
    // committed Linux baseline.
    expect(jobs["sweep-linux"]).toMatch(/container:\s*\n\s*image:\s*mcr\.microsoft\.com\/playwright:/);
  });

  it("all three platforms run the SAME shard script", () => {
    // Divergent inline flags would produce three baselines that look comparable
    // and were taken over different slices.
    for (const os of ["macos", "linux", "windows"]) {
      expect(jobs[`sweep-${os}`], `sweep-${os}`).toMatch(/bash scripts\/ci-font-conformance-shard\.sh/);
    }
  });

  it("shard artifacts are namespaced by platform", () => {
    // A shared artifact name would let the aggregate merge a macOS shard into a
    // Linux total — the single worst thing this workflow could do quietly.
    for (const os of ["macos", "linux", "windows"]) {
      expect(jobs[`sweep-${os}`]).toContain(`font-conformance-${os}-shard-`);
    }
  });

  it("the aggregate gates each platform against ITS OWN baseline", () => {
    const job = jobs["aggregate"];
    expect(job).toMatch(/merge-font-conformance-shards\.mjs/);
    expect(job).toMatch(/diff-font-conformance-baseline\.mjs/);
    expect(job).toMatch(/tests\/baselines\/font-conformance-\$\{\{ matrix\.os \}\}\.json/);
  });

  it("the aggregate is told how many shards to expect, across BOTH axes", () => {
    // Without it a run whose shards died would merge the survivors and report a
    // smaller mismatch total, which reads as an improvement.
    //
    // DM-1887: the matrix is now `shards x cp_shards`, so `inputs.shards` alone
    // would under-state the denominator — and under-stating it is precisely the
    // failure this assertion exists to prevent: with cp_shards=5 the aggregate
    // would accept 6 of 30 reports as complete. The count is computed once in
    // `setup` and passed through, so the workflow has a single source of truth.
    expect(jobs["aggregate"]).toMatch(/--expected \$\{\{ needs\.setup\.outputs\.expected \}\}/);
    expect(jobs["setup"]).toMatch(/expected=\$\(\(n \* c\)\)/);
  });

  it("fans out on both axes, with unique artifact names per cell", () => {
    // Two dimensions in the matrix; GitHub takes their cross product.
    expect(jobs["setup"]).toMatch(/\\"shard\\":\[\$list\],\\"cp\\":\[\$cplist\]/);
    // An artifact name that omitted the cp index would have every codepoint
    // shard of a stack overwrite its siblings — the merge would then see one
    // report per stack shard, silently sweeping a fraction of the universe while
    // reporting `complete`.
    for (const os of ["macos", "linux", "windows"]) {
      expect(jobs[`sweep-${os}`]).toContain(
        `name: font-conformance-${os}-shard-\${{ matrix.shard }}-cp\${{ matrix.cp }}`.replace(/\\/g, ""),
      );
    }
  });

  it("defaults the codepoint axis to 1, so the shipped shape is unchanged", () => {
    // `cp_shards: 1` must keep the shard script from passing `--shard` at all —
    // the merge keys its codepoint accounting off `meta.shard` being null, and a
    // gratuitous `--shard 1/1` would make a 1-D run look 2-D.
    expect(yaml).toMatch(/cp_shards:[\s\S]{0,400}?default: '1'/);
  });
});
