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

  it("Linux needs NO helper — its resolver shells out to fontconfig", () => {
    // Stated so the asymmetry stays deliberate rather than being 'fixed' later
    // by adding a build step for a helper the Linux resolver never calls.
    expect(jobs["sweep-linux"]).not.toMatch(/linux-glyph-extractor/);
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

  it("the aggregate is told how many shards to expect", () => {
    // Without it a run whose shards died would merge the survivors and report a
    // smaller mismatch total, which reads as an improvement.
    expect(jobs["aggregate"]).toMatch(/--expected \$\{\{ inputs\.shards \}\}/);
  });
});
