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

  // DM-1972: this assertion used to be its own inverse — "Linux needs NO helper
  // step", stated as a test so the asymmetry could not be 'fixed' by someone
  // adding a build for a helper Linux never used. That was correct while the
  // only live Linux mechanism was the `fcfallback` per-codepoint query, which
  // does shell out to fontconfig directly. It stopped being correct when the
  // declared-family matcher (`SkFontConfigInterfaceDirect::matchFamilyName`,
  // Skia rev fd139e79) was transcribed into the helper's `familyMatch` query:
  // `resolveLinuxFamilyMatch` returns null without a helper that knows it, and
  // the caller silently degrades to the two-slot key/key-bold table.
  //
  // Measured in the pinned noble container — arial@550 resolves to
  // LiberationSans-Bold with the helper and LiberationSans without, and the
  // feature suite's text-font-stretch-underline went 0.703% (pass) → 1.989%
  // (fail), matching the CI number exactly.
  //
  // Kept as an explicit test in the inverted direction for the same reason the
  // original existed: so the requirement is deliberate rather than incidental.
  it("the Linux sweep job builds the fontconfig helper — its matcher is not free-standing", () => {
    const job = jobs["test-linux"];
    expect(job, "test-linux job must exist").toBeDefined();
    expect(
      /linux-glyph-extractor/.test(job),
      "test-linux runs the sweep without building tools/linux-glyph-extractor — the transcribed "
      + "declared-family matcher will be inert and cut selection drops to the two-slot table",
    ).toBe(true);
  });

  it("builds the Linux helper BEFORE the shard runs", () => {
    const job = jobs["test-linux"];
    const build = job.indexOf("linux-glyph-extractor");
    const run = job.indexOf("Run shard");
    expect(build).toBeGreaterThanOrEqual(0);
    expect(run).toBeGreaterThanOrEqual(0);
    expect(build, "the helper must be built before the sweep runs").toBeLessThan(run);
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

  // DM-1859: every renderer A/B flag must be dispatchable AND reach all three
  // sweep jobs. A flag with a workflow input but no `env:` wiring in some job
  // produces the worst possible result: that job silently runs the RENDERER
  // DEFAULT while the run is labelled as the other arm, and its report looks
  // like a legitimate measurement. The A/B then "shows no difference" for a
  // reason that has nothing to do with the code under test.
  //
  // Not hypothetical. DM-1868's landing note quoted a CJK-slice figure of 29,025
  // as that flag's own result; re-measuring as a 2×2 showed the figure required
  // a SECOND flag that was still off by default, and the flag alone accounts for
  // 556 of the 84,382 rows. Wrong-arm measurements are the recurring failure in
  // this area, so the wiring is pinned rather than trusted.
  describe("renderer A/B flags are dispatchable and reach every sweep job", () => {
    const AB_FLAGS = [
      { input: "hinted_subset", env: "DOMOTION_HINTED_SUBSET" },
      { input: "fallback_base", env: "DOMOTION_FALLBACK_BASE" },
      { input: "live_fallback_first", env: "DOMOTION_LIVE_FALLBACK_FIRST" },
      { input: "system_ui_base", env: "DOMOTION_SYSTEM_UI_BASE" },
      { input: "trak_hb_shaping", env: "DOMOTION_TRAK_HB_SHAPING" },
    ];

    for (const { input, env } of AB_FLAGS) {
      it(`${env} has a workflow input and is wired into macOS, Linux and Windows`, () => {
        expect(yaml, `missing workflow_dispatch input \`${input}\``).toMatch(
          new RegExp(`^ {6}${input}:`, "m"),
        );
        for (const job of ["test-macos", "test-linux", "test-windows"]) {
          expect(
            jobs[job]?.includes(`${env}: \${{ inputs.${input} }}`),
            `${job} does not pass ${env} through — that job would silently run the renderer default`,
          ).toBe(true);
        }
      });
    }

    it("every renderer DOMOTION_ env the workflow passes is dispatch-controlled, not a hardcoded arm", () => {
      // Catches the inverse drift: a renderer flag pinned to a literal in the
      // workflow, which makes one arm permanently unreachable and every future
      // A/B against it silently a no-op.
      //
      // Allowlisted: settings that configure the RUNNER rather than the
      // renderer's font/paint decisions. `DOMOTION_NO_NICE` disables the
      // harness's `nice` self-throttling, which is correct to force on a CI box
      // and is not an arm of anything.
      const RUNNER_ENV = new Set(["DOMOTION_NO_NICE"]);
      const passed = [...yaml.matchAll(/^\s+(DOMOTION_[A-Z0-9_]+): (.*)$/gm)];
      expect(passed.length, "guard is vacuous — no DOMOTION_ envs found").toBeGreaterThan(0);
      for (const [, name, value] of passed) {
        if (RUNNER_ENV.has(name)) continue;
        expect(
          /^\$\{\{ (inputs|env)\./.test(value.trim()),
          `${name} is hardcoded to \`${value.trim()}\` — that arm cannot be dispatched`,
        ).toBe(true);
      }
    });
  });
});

// DM-1972: the same guard for the Linux FIDELITY GATE, which is a different
// workflow and was the one actually caught measuring the wrong configuration.
//
// `test-linux.yml`'s `regression` job is (or is intended to be) a REQUIRED
// status check, and it was `npm ci` + `npm run demos:test` with no helper build
// — so every Linux fidelity number the project had been reading came from a
// render path the declared-family matcher was not in. It reported a stable,
// plausible number the whole time, which is precisely why nothing noticed; the
// sibling family-match job passes because it DOES build the helper.
//
// Pinned here rather than trusted because the failure is silent in both
// directions: dropping the build step turns the gate green about code that is
// not running, and there is no output difference that would say so.
describe("test-linux.yml's fidelity gate measures the shipped mechanism", () => {
  const yaml = readFileSync(
    resolve(__dirname, "..", ".github", "workflows", "test-linux.yml"), "utf-8",
  );

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
      } else if (cur != null) buf.push(line);
    }
    if (cur != null) out[cur] = buf.join("\n");
    return out;
  })();

  it("parses the workflow into jobs (guard is not vacuous)", () => {
    expect(Object.keys(jobs)).toEqual(expect.arrayContaining(["regression", "family-match"]));
  });

  it("builds the Linux glyph helper before running the feature suite", () => {
    const job = jobs["regression"];
    expect(job, "regression job must exist").toBeDefined();
    const build = job.indexOf("linux-glyph-extractor/build.sh");
    // Anchor on the RUN line, not the string `demos:test` — the job's own
    // rationale comment names the command, and matching that would compare
    // against prose rather than a step.
    const run = job.search(/^\s+run: npm run demos:test/m);
    expect(
      build, "the fidelity gate runs demos:test without building the helper — it would grade the "
      + "degraded two-slot cut selection, not the transcribed fontconfig matcher",
    ).toBeGreaterThanOrEqual(0);
    expect(build, "the helper must be built before the suite runs").toBeLessThan(run);
  });

  it("asserts the helper is in the loop, not merely built", () => {
    // A built binary is not a reached one, and `isGlyphHelperAvailable()` is not
    // the predicate that distinguishes them: with the in-tree binary absent it
    // still returns true, because the resolver falls through to downloading the
    // published release asset — which predates `familyMatch` and answers
    // "unknown query type". Measured in the pinned noble image. So the gate runs
    // an explicit disable-and-require-movement check at a discriminating rung.
    expect(jobs["regression"]).toMatch(/assert-linux-helper-in-loop/);
  });

  it("installs the fontconfig headers the helper build needs to configure", () => {
    // A bare cmake install fails at `find_package(Fontconfig)` with a confusing
    // first error; the same omission red-lit the glyph-extractor-build job.
    expect(jobs["regression"]).toMatch(/libfontconfig-dev/);
  });
});
