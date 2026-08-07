/**
 * DM-2017: the Linux `fcfallback` live resolver's `isBold` / `isItalic` bits —
 * plumbed through the helper protocol and parsed on the Node side
 * (`resolveFcFallbackFonts`), but never READ by the sole consumer before this
 * fix. Blink mutates the description and sets synthetic bold/italic from
 * exactly those bits (`linux/font_cache_linux.cc:106-129`, rev 7d859f27) — a
 * binary test that OVERRIDES the general Linux weight-delta rule specifically
 * for a system-fallback pick. Dropping the bits meant a bold run over a
 * fallback-only codepoint painted with no synthetic-bold geometry at all: it
 * read as a rasterization difference rather than the logic bug it was.
 *
 * Same cassette-replay construction as `linux-fallback-crossplatform.test.ts`
 * (DM-1980): `hostPlatform()` is overridden and the glyph helper's IPC is
 * replayed from `tests/cassettes/linux-fallback.json`, which carries a
 * hand-authored `isBold:true, isItalic:true` entry for a fake test face (★
 * U+2605, chosen because it collides with none of that cassette's other
 * entries) alongside its four real recorded ones. The response shape matches
 * what `tools/linux-glyph-extractor/src/main.cpp`'s `runFcFallbackQuery`
 * actually emits — see the comment above `resolveFcFallbackFonts` for the
 * schema — so this proves the WIRING (helper answer → registered spec →
 * `FontInstance` → synthesis predicate), not a fabricated shortcut.
 *
 * Two layers, per the project's double-coverage rule:
 *   1. WIRING — the resolved key's spec actually carries the bits (this file).
 *   2. LOGIC — the predicate makes the right call GIVEN the bits
 *      (`synthesis-decision.test.ts`, which is host-independent and is the
 *      one that discriminates most directly against the unfixed code: the OLD
 *      Linux rule was a pure weight delta that never consulted a bold flag at
 *      all, so it disagreed with the fix on cases the delta rule alone gets
 *      wrong in EITHER direction).
 *
 * `getFontInstance` cannot be exercised here — it opens the fake path for
 * real, and `/usr/share/fonts/truetype/dm2017-test/FakeBoldItalic.ttf` exists
 * on no host — so, like the sibling cassette file, the boundary is DECISIONS
 * (the registered spec), not materialized faces. `npm run test:linux-docker`
 * is where a real bold fallback face round-trips end to end.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const CASSETTE = resolve(HERE, "..", "..", "tests", "cassettes", "linux-fallback.json");
const REPLAYER = resolve(HERE, "..", "..", "tools", "font-env-cassette.mjs");

// Must be set BEFORE the glyph helper is first imported — see the sibling
// cassette file's comment for why (`isGlyphHelperAvailable()` memoizes for
// the life of the process and has no reset hook).
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

// ★ BLACK STAR (U+2605) — a codepoint with no legitimate claim on any real
// script block, so it can't collide with a future addition to the shared
// cassette and its "fake bold italic" answer can never be mistaken for a real
// probe result.
const FAKE_CP = 0x2605;

describe("Linux fcfallback isBold/isItalic reach the registered spec (DM-2017)", () => {
  it("carries isBold/isItalic through to the resolved key's FontPath", () => {
    const key = host.withHostPlatform("linux", () =>
      fonts.__resolveSystemFallbackKeyForCpForTest(FAKE_CP, 700, 0, 16, "helvetica"));
    expect(key).not.toBeNull();
    expect(key).toMatch(/^sysfb:/);

    const spec = fonts.__resolveFontSpecForTest(key!);
    expect(spec).not.toBeNull();
    // The load-bearing assertions: BEFORE this fix, `registerDynamicSystemFont`
    // was called with only (key, path, name, "fontkit") — the two trailing
    // arguments never existed, so this pair would be `undefined` on every
    // Linux fallback pick regardless of what the helper answered.
    expect(spec!.linuxFallbackIsBold).toBe(true);
    expect(spec!.linuxFallbackIsItalic).toBe(true);
  });

  it("leaves the bits undefined for a plain (non-bold) fallback pick", () => {
    // Control, using one of the sibling file's pre-existing recorded entries
    // (中, U+4E2D, isBold:false/isItalic:false in the recording) — proves the
    // wiring reports what the helper actually said rather than defaulting
    // every pick to bold.
    const key = host.withHostPlatform("linux", () =>
      fonts.__resolveSystemFallbackKeyForCpForTest(0x4e2d, 400, 0, 16, "helvetica"));
    expect(key).not.toBeNull();
    const spec = fonts.__resolveFontSpecForTest(key!);
    expect(spec!.linuxFallbackIsBold).toBe(false);
    expect(spec!.linuxFallbackIsItalic).toBe(false);
  });

});
