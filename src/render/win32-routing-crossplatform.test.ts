// Windows font-routing DECISIONS, exercised on any host (DM-1980).
//
// The Windows sibling of `linux-routing-crossplatform.test.ts`, and the same
// bargain: the DirectWrite family match — what Blink reaches through
// `FontCache::CreateFontPlatformData` (`win/font_cache_skia_win.cc`, rev
// 7d859f27) — is asserted here in the 30-second unit suite on any machine,
// against a cassette recorded on a real Windows host.
//
// Windows previously had NO declared-family cut test at all. macOS has
// `darwin-declared-family-cut.test.ts` and Linux has
// `linux-declared-family-cut.test.ts`; the Windows equivalent did not exist,
// because writing one meant either owning a Windows machine or waiting on the
// `windows-fidelity.yml` dispatch. That asymmetry is the gap this closes.
//
// ── What this can and cannot prove ────────────────────────────────────────────
//
// The cassette records what DirectWrite answered on the Parallels Windows 11
// VM. So this proves our LOGIC is right *given* those answers; it does not
// prove the answers are right, and it cannot notice DirectWrite changing its
// mind on a different Windows build or font inventory. The Windows CI job and
// the family-match conformance oracle remain what establish parity, and nothing
// here reduces how often they run.
//
// Scope is DECISIONS — which face a declared family resolves to at a style.
// Materializing that face still needs the real font bytes, so anything past
// `getFontInstance` stays on-platform (measured under DM-1980, not assumed).
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, beforeAll } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

// Must be set before the glyph helper is first imported — `isGlyphHelperAvailable()`
// memoizes its probe for the life of the process and deliberately has no reset
// hook. Vitest gives each test file a fresh module registry, so setting these
// here and importing dynamically below is enough.
process.env.DOMOTION_HELPER_PATH = resolve(HERE, "..", "..", "tools", "font-env-cassette.mjs");
process.env.FONT_CASSETTE = resolve(HERE, "..", "..", "tests", "cassettes", "win32.json");
process.env.FONT_CASSETTE_MODE = "replay";

type GlyphHelper = typeof import("./glyph-helper.js");
type HostPlatformMod = typeof import("./host-platform.js");
let helper: GlyphHelper;
let host: HostPlatformMod;

beforeAll(async () => {
  helper = await import("./glyph-helper.js");
  host = await import("./host-platform.js");
});

/** The recorded answer for a declared family at a style. */
const face = (family: string, weight: number, italic = false): string | null =>
  helper.resolveInstalledFont(family, { weight, italic, stretch: 100 })?.postscriptName ?? null;

describe("Windows declared-family cut selection, replayed on any host (DM-1980)", () => {
  it("walks Segoe UI's real weight ladder rather than collapsing to one cut", () => {
    // Segoe UI is the case worth pinning: it ships Light / Semibold / Bold as
    // separate faces, so a matcher that ignored the requested weight — or that
    // only knew a two-slot regular/bold split — would answer `SegoeUI` for all
    // four of these and still look plausible.
    host.withHostPlatform("win32", () => {
      expect(face("Segoe UI", 300)).toBe("SegoeUI-Light");
      expect(face("Segoe UI", 400)).toBe("SegoeUI");
      expect(face("Segoe UI", 600)).toBe("SegoeUI-Semibold");
      expect(face("Segoe UI", 700)).toBe("SegoeUI-Bold");
    });
  });

  it("keeps the slope independent of the weight", () => {
    host.withHostPlatform("win32", () => {
      expect(face("Segoe UI", 400, true)).toBe("SegoeUI-Italic");
      // …and asking for italic did not disturb the upright column.
      expect(face("Segoe UI", 400)).toBe("SegoeUI");
    });
  });

  it("crosses to bold at 550, where DirectWrite's own scoring crosses", () => {
    // The rung that DISCRIMINATES, and the same one that matters on Linux: a
    // two-slot table crossing at 600 would answer ArialMT here. DirectWrite
    // scores 550 closer to the bold cut, and so must we.
    host.withHostPlatform("win32", () => {
      expect(face("Arial", 400)).toBe("ArialMT");
      expect(face("Arial", 550)).toBe("Arial-BoldMT");
      expect(face("Arial", 700)).toBe("Arial-BoldMT");
    });
  });

  it("reports a suffix-carrying family as absent, which is what makes Blink retry", () => {
    // "Segoe UI Light" and "Arial Narrow" are NOT DirectWrite families. Blink
    // only reaches their faces by stripping the known weight/stretch suffix and
    // re-asking with that value replacing the axis
    // (`win/font_cache_skia_win.cc:409-480`, tables at :335-407). If the raw
    // name resolved here, that retry would never happen and the suffix layer
    // would be silently dead.
    host.withHostPlatform("win32", () => {
      expect(face("Segoe UI Light", 400)).toBeNull();
      expect(face("Arial Narrow", 400)).toBeNull();
    });
  });

  it("resolves the math family Blink's math stage depends on", () => {
    host.withHostPlatform("win32", () => {
      expect(face("Cambria Math", 400)).toBe("CambriaMath");
      expect(face("Times New Roman", 700)).toBe("TimesNewRomanPS-BoldMT");
    });
  });
});
