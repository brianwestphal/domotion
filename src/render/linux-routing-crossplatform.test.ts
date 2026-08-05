// Linux font-routing DECISIONS, exercised on any host (DM-1980).
//
// This is the payoff of the host-platform seam plus a recorded helper cassette:
// the Linux declared-family matcher — the transcription of
// `SkFontConfigInterfaceDirect::matchFamilyName` (Skia rev fd139e79) — is
// asserted here in the 30-second unit suite, on macOS, Linux or Windows alike.
//
// Its sibling `linux-declared-family-cut.test.ts` asserts the same mechanism
// against the REAL host and `describe.skip`s itself everywhere except Linux
// with a freshly-built helper. That file remains the ground truth; this one is
// the fast pre-filter that catches a logic regression in milliseconds instead
// of a 3-minute container round-trip.
//
// ── What this can and cannot prove ────────────────────────────────────────────
//
// The cassette is a RECORDING of what fontconfig answered in the pinned noble
// container. So this file proves our LOGIC is right *given* those answers. It
// does not prove the answers are right, and it cannot notice if the real
// fontconfig starts answering differently — that is what the Linux CI job and
// the family-match conformance oracle are for, and nothing here reduces how
// often those run. A cassette is a sample, and samples in this area are blind
// rather than wrong while still scoring well.
//
// Scope is DECISIONS only — which family, which cut, which path. Materializing
// a face still needs the real font bytes (`getFontInstance` opens the file), so
// anything downstream of that stays on-platform. That boundary was measured,
// not assumed: with the platform overridden and the cassette replaying,
// `resolveLinuxFamilyMatch` answers correctly on macOS while `getFontInstance`
// returns undefined because `/usr/share/fonts/...` is not there.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { describe, expect, it, beforeAll } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const CASSETTE = resolve(HERE, "..", "..", "tests", "cassettes", "linux.json");
const REPLAYER = resolve(HERE, "..", "..", "tools", "font-env-cassette.mjs");

// The helper path and cassette must be in the environment BEFORE the glyph
// helper module is first imported: `isGlyphHelperAvailable()` memoizes its
// probe for the life of the process and has no reset hook (deliberately — a
// fresh process starts clean). Vitest gives each test file its own module
// registry, so setting them here and importing dynamically is enough.
process.env.DOMOTION_HELPER_PATH = REPLAYER;
process.env.FONT_CASSETTE = CASSETTE;
process.env.FONT_CASSETTE_MODE = "replay";

type GlyphHelper = typeof import("./glyph-helper.js");
type HostPlatformMod = typeof import("./host-platform.js");
let helper: GlyphHelper;
let host: HostPlatformMod;

beforeAll(async () => {
  helper = await import("./glyph-helper.js");
  host = await import("./host-platform.js");
});

describe("Linux declared-family cut selection, replayed on any host (DM-1980)", () => {
  it("crosses to the bold cut where fontconfig does, not where the two-slot table would", () => {
    // CSS 550 is the rung that DISCRIMINATES, and it is the reason this file is
    // worth having: the fallback two-slot `key` / `key-bold` table crosses to
    // bold at 600, while fontconfig's weight scoring already prefers Bold at
    // 550. A check at 400 or 700 agrees on both paths and proves nothing.
    host.withHostPlatform("linux", () => {
      expect(helper.resolveLinuxFamilyMatch("Arial", { weight: 550 })?.postscriptName)
        .toBe("LiberationSans-Bold");
      expect(helper.resolveLinuxFamilyMatch("Arial", { weight: 400 })?.postscriptName)
        .toBe("LiberationSans");
      expect(helper.resolveLinuxFamilyMatch("Liberation Sans", { weight: 700 })?.postscriptName)
        .toBe("LiberationSans-Bold");
    });
  });

  it("answers nothing OUTSIDE the override — so the override is doing the work", () => {
    // Without this, the file would pass just as well if the override did
    // nothing and some other mechanism were supplying the answers.
    //
    // Only meaningful off-Linux: on a real Linux host the matcher answers
    // whether or not anything is overridden, which is correct and is exactly
    // what the ground-truth sibling test asserts. Caught by running this file
    // in the container rather than reasoned about.
    if (process.platform === "linux") return;
    expect(helper.resolveLinuxFamilyMatch("Arial", { weight: 550 })).toBeNull();
  });

  it("restores the real platform after the scope, so later tests are unaffected", () => {
    const before = host.hostPlatform();
    host.withHostPlatform("linux", () => {
      expect(host.hostPlatform()).toBe("linux");
    });
    expect(host.hostPlatform()).toBe(before);
    expect(host.hostPlatform()).toBe(process.platform);
  });

  it("restores the platform even when the body throws", () => {
    const before = host.hostPlatform();
    expect(() => host.withHostPlatform("win32", () => { throw new Error("boom"); })).toThrow("boom");
    expect(host.hostPlatform()).toBe(before);
  });
});
