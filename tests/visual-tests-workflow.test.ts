import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The visual sweep is only a fidelity signal if the runner renders the way a
// developer does. On macOS and Windows the per-codepoint fallback resolver asks
// the OS (CoreText / DirectWrite) through a native helper binary — and that
// binary is gitignored, so a fresh CI checkout does not have one unless the
// workflow builds it. Without it `isGlyphHelperAvailable()` goes false and font
// selection silently drops to the static fallback chain, which picks different
// faces than the browser. That is not drift, it is a different renderer.
//
// It cost a sweep of "wrong font" unicode failures that no one could reproduce
// locally, precisely because the developer's tree HAS the binary. Reproduced by
// disabling the helper on a Mac: `0400-04FF-cyrillic` went from clean (0
// regions) to major (142 regions).
//
// The failure mode is workflow drift — a job that runs the suite without
// building the helper — so the guard reads the workflow rather than the code.

const WORKFLOW = resolve(__dirname, "..", ".github", "workflows", "visual-tests.yml");

describe("visual-tests.yml provides the native glyph helper", () => {
  const yaml = readFileSync(WORKFLOW, "utf-8");

  // Split into job blocks by the 2-space-indented job keys.
  const jobs = (() => {
    const out: Record<string, string> = {};
    const lines = yaml.split("\n");
    let cur: string | null = null;
    let buf: string[] = [];
    for (const line of lines) {
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
    expect(Object.keys(jobs)).toEqual(expect.arrayContaining(["test-macos", "test-linux", "test-windows"]));
  });

  it("the macOS sweep job builds the CoreText helper before running the suite", () => {
    const job = jobs["test-macos"];
    expect(job, "test-macos job must exist").toBeDefined();
    expect(
      /macos-glyph-extractor/.test(job),
      "test-macos runs the sweep without building tools/macos-glyph-extractor — the live CoreText "
      + "fallback resolver will be OFF and font selection will not match the browser",
    ).toBe(true);
  });

  it("builds the helper BEFORE the shard runs, not after", () => {
    const job = jobs["test-macos"];
    const build = job.indexOf("macos-glyph-extractor");
    const run = job.indexOf("Run shard");
    expect(build).toBeGreaterThanOrEqual(0);
    expect(run).toBeGreaterThanOrEqual(0);
    expect(build, "the helper must be built before the sweep runs").toBeLessThan(run);
  });

  it("the Windows sweep job builds the DirectWrite helper", () => {
    const job = jobs["test-windows"];
    expect(job, "test-windows job must exist").toBeDefined();
    expect(
      /win32-glyph-extractor/.test(job),
      "test-windows runs the sweep without building tools/win32-glyph-extractor — the live "
      + "DirectWrite fallback resolver will be OFF",
    ).toBe(true);
  });

  it("Linux needs NO helper step — its resolver shells out to fontconfig", () => {
    // Stated as a test so the asymmetry is deliberate rather than an oversight
    // someone later 'fixes' by adding a build step for a helper Linux never uses.
    expect(jobs["test-linux"]).not.toMatch(/linux-glyph-extractor/);
  });

  // DM-1843: `include_svg` kept the SVGs in the shard artifacts, but the step
  // that publishes to the `domotion-ci-images` transport repo hard-filtered to
  // `*.png` — so the input could never put an SVG where the review UI reads
  // from, which is precisely the evidence a runner-only failure needs. Verified
  // empirically: run 30322700111 (include_svg=true) published 110 files, zero
  // of them `.svg`, while its raw shard artifacts held 36.
  it("the images publish step can carry SVGs, not only PNGs", () => {
    const job = jobs["aggregate"];
    expect(job, "aggregate job must exist").toBeDefined();
    const publish = job.slice(job.indexOf("Push images to domotion-ci-images"));
    expect(
      /-name "\*\.svg"/.test(publish),
      "the publish step copies only *.png, so include_svg can never reach the review UI",
    ).toBe(true);
    // Gated, not unconditional — SVGs are ~85% of the weight.
    expect(publish).toMatch(/INCLUDE_SVG/);
  });

  it("copies the built binary to the path the resolver looks for", () => {
    // `HELPER_BINARIES.darwin` in src/render/glyph-helper.ts resolves exactly
    // this filename; `swift build` emits `DomotionGlyphPaths`, so a build that
    // forgets the copy leaves the resolver seeing nothing.
    expect(jobs["test-macos"]).toMatch(/domotion-glyph-paths/);
  });
});
