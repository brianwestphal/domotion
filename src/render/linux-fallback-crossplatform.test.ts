// Linux PER-CODEPOINT fallback decisions, exercised on any host (DM-1980).
//
// The sibling `linux-routing-crossplatform.test.ts` replays the *declared-family
// cut* matcher. This one goes after the other large host-dependent surface: the
// per-codepoint system-fallback resolver, which decides which face paints a
// character no declared family covers. It is the stage that decides ~25% of all
// answers (measured by `tools/probe-resolver-stage-attribution.mts`), and until
// now it could only be exercised on the platform itself.
//
// Same construction as its sibling: `hostPlatform()` is overridden and the glyph
// helper's IPC is replayed from a cassette recorded inside the pinned noble
// container, so fontconfig's answers are an INPUT rather than an ambient fact.
//
// ── What this can and cannot prove ────────────────────────────────────────────
//
// The cassette is a recording, so this proves our LOGIC is right *given* those
// answers. It cannot notice fontconfig changing its mind — that is what the
// Linux CI job and the conformance oracle are for, and nothing here reduces how
// often they run. A cassette is a sample, and samples in this area are blind
// rather than wrong while still scoring well.
//
// The boundary is DECISIONS, not faces: `getFontInstance` opens
// `/usr/share/fonts/...`, which does not exist here, so anything downstream of a
// materialized face stays on-platform. That is why every assertion below is
// about the resolved KEY.
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const CASSETTE = resolve(HERE, "..", "..", "tests", "cassettes", "linux-fallback.json");
const REPLAYER = resolve(HERE, "..", "..", "tools", "font-env-cassette.mjs");

// Must be set BEFORE the glyph helper is first imported: `isGlyphHelperAvailable()`
// memoizes its probe for the life of the process and has no reset hook.
// `FONT_CASSETTE_MODE` is left to the environment so the same file drives the
// recording pass inside the container (`record`) and the replay pass here.
process.env.DOMOTION_HELPER_PATH = REPLAYER;
process.env.FONT_CASSETTE = CASSETTE;
process.env.FONT_CASSETTE_MODE ??= "replay";

type FontRes = typeof import("./font-resolution.js");
type HostMod = typeof import("./host-platform.js");
let fonts: FontRes;
let host: HostMod;

beforeAll(async () => {
  fonts = await import("./font-resolution.js");
  host = await import("./host-platform.js");
});

/**
 * The characters, and why each earns its place. Every one is a DIFFERENT branch
 * of the Linux resolver, so a regression in one shows as one failure rather than
 * all five moving together.
 */
const CASES: Array<{ cp: number; name: string; why: string }> = [
  { cp: 0x4e2d, name: "CJK ideograph 中", why: "the Han branch — locale-keyed, and the largest block by far" },
  { cp: 0x0905, name: "Devanagari अ", why: "an Indic script with its own Noto face" },
  { cp: 0x05d0, name: "Hebrew א", why: "an RTL script, a different fontconfig family" },
  { cp: 0x1f600, name: "emoji 😀", why: "the bitmap colour font — the cmap-vs-outline coverage fix" },
];

// Replay needs the cassette; the recording pass creates it.
const haveCassette = existsSync(CASSETTE);
const describeIf = haveCassette || process.env.FONT_CASSETTE_MODE === "record" ? describe : describe.skip;

describeIf("Linux per-codepoint fallback, replayed on any host (DM-1980)", () => {
  it("resolves each script to a face, with the platform overridden", () => {
    const answers = host.withHostPlatform("linux", () =>
      CASES.map((c) => ({ ...c, key: fonts.__resolveSystemFallbackKeyForCpForTest(c.cp, 400, 0, 16, "helvetica") })));

    for (const a of answers) {
      expect(a.key, `${a.name} (${a.why}) resolved to nothing`).not.toBeNull();
      // `sysfb:` is the marker for a face the LIVE resolver nominated, as
      // opposed to a static-chain key. Asserting it is what separates "the
      // fontconfig path ran" from "something else answered".
      expect(a.key, `${a.name} did not come from the live resolver`).toMatch(/^sysfb:/);
    }

    // DISCRIMINATION: four scripts must not all land on one face. If they do,
    // the resolver is answering from something script-blind and every assertion
    // above would pass against it.
    expect(new Set(answers.map((a) => a.key)).size,
      `all four scripts resolved to the same face: ${answers.map((a) => a.key).join(", ")}`)
      .toBeGreaterThan(1);
  });

  it("gives the emoji codepoint a COLOUR face, not the text primary", () => {
    // The Linux-specific coverage fix: `NotoColorEmoji.ttf` is bitmap-only, so
    // fontkit maps U+1F600 in its cmap but can build no Glyph for it. A coverage
    // check phrased as "can an outline be built" answered "not covered" for the
    // one font on the system that does cover it, and every emoji fell through to
    // the primary. This is that regression, catchable off-Linux for the first
    // time.
    const key = host.withHostPlatform("linux", () =>
      fonts.__resolveSystemFallbackKeyForCpForTest(0x1f600, 400, 0, 16, "helvetica"));
    expect(key).not.toBeNull();
    expect(key!.toLowerCase()).toContain("emoji");
  });

  it("is actually replaying — the answers differ from this host's own", () => {
    // Non-vacuity. Without the platform override the same call takes the host's
    // real resolver, and on any non-Linux machine that must give a different
    // face. If the two agree, the override is not in the loop and every
    // assertion above is about this machine rather than about Linux.
    if (host.hostPlatform() === "linux") return; // on Linux they legitimately agree
    const asLinux = host.withHostPlatform("linux", () =>
      fonts.__resolveSystemFallbackKeyForCpForTest(0x4e2d, 400, 0, 16, "helvetica"));
    const asHost = fonts.__resolveSystemFallbackKeyForCpForTest(0x4e2d, 400, 0, 16, "helvetica");
    expect(asLinux).not.toBe(asHost);
  });
});
