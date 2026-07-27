import { describe, it, expect } from "vitest";
import { resolveHarnessFlags, captureFlagsCacheToken, harnessBrowserNote, expectedCachePlatformDir, __resetFontDigestForTest } from "./harness-browsers.js";

// DM-1790 (docs/105): the visual harnesses drive ONE Chromium for both the
// expected paint and the candidate SVG's rasterization, so a `chromium.launch`
// flag meant for one side silently moves both. These cover the pure decision
// logic — which configuration was asked for, and how it must perturb the
// expected-PNG cache key — without launching a browser.
describe("harness capture/raster browser flags (DM-1790)", () => {
  describe("resolveHarnessFlags", () => {
    it("neither var set → one browser (today's fast path)", () => {
      const r = resolveHarnessFlags({});
      expect(r).toEqual({ captureFlags: [], rasterFlags: [], asymmetric: false });
    });

    it("capture only → ASYMMETRIC: flagged capture, unflagged raster", () => {
      const r = resolveHarnessFlags({ DOMOTION_CAPTURE_FLAGS: "--font-render-hinting=none" });
      expect(r).toEqual({ captureFlags: ["--font-render-hinting=none"], rasterFlags: [], asymmetric: true });
    });

    it("raster only → also asymmetric (the mirror case)", () => {
      expect(resolveHarnessFlags({ DOMOTION_RASTER_FLAGS: "--disable-lcd-text" }).asymmetric).toBe(true);
    });

    it("both set to the SAME list → one browser, flagged (the historical coupled behavior)", () => {
      const r = resolveHarnessFlags({
        DOMOTION_CAPTURE_FLAGS: "--disable-lcd-text --font-render-hinting=none",
        DOMOTION_RASTER_FLAGS: "--disable-lcd-text --font-render-hinting=none",
      });
      expect(r.asymmetric).toBe(false);
      expect(r.captureFlags).toEqual(["--disable-lcd-text", "--font-render-hinting=none"]);
    });

    it("same flags in a DIFFERENT order still split the browser (conservative)", () => {
      expect(resolveHarnessFlags({
        DOMOTION_CAPTURE_FLAGS: "--a --b",
        DOMOTION_RASTER_FLAGS: "--b --a",
      }).asymmetric).toBe(true);
    });

    it("blank / whitespace-only is the same as unset", () => {
      expect(resolveHarnessFlags({ DOMOTION_CAPTURE_FLAGS: "   " })).toEqual(
        { captureFlags: [], rasterFlags: [], asymmetric: false },
      );
    });

    it("collapses runs of whitespace between flags", () => {
      expect(resolveHarnessFlags({ DOMOTION_CAPTURE_FLAGS: "  --a\t\t--b  " }).captureFlags).toEqual(["--a", "--b"]);
    });
  });

  // The cache-key token is the load-bearing part: `html-test-suite.tsx` caches
  // the expected screenshot, and a capture-side flag changes that screenshot
  // while changing nothing else in the key. Without the token a flagged run
  // reuses the unflagged PNG and reports numbers for a condition it never ran.
  describe("captureFlagsCacheToken", () => {
    it("is EMPTY with no capture flags — every existing cache entry stays valid", () => {
      expect(captureFlagsCacheToken({})).toBe("");
      expect(captureFlagsCacheToken({ DOMOTION_CAPTURE_FLAGS: "" })).toBe("");
    });

    it("distinguishes flagged from unflagged, and one flag set from another", () => {
      const a = captureFlagsCacheToken({ DOMOTION_CAPTURE_FLAGS: "--font-render-hinting=none" });
      const b = captureFlagsCacheToken({ DOMOTION_CAPTURE_FLAGS: "--disable-lcd-text" });
      expect(a).not.toBe("");
      expect(a).not.toBe(b);
    });

    it("ignores the RASTER flags — they only affect actual.png, which is never cached", () => {
      expect(captureFlagsCacheToken({ DOMOTION_RASTER_FLAGS: "--disable-lcd-text" })).toBe("");
    });
  });

  // DM-1794: the expected-PNG cache holds SCREENSHOTS, so it must be
  // partitioned by the platform whose Chromium took them — macOS CoreText vs
  // Linux FreeType vs Windows DirectWrite paint differently, which is why the
  // project keeps three fallback calibrations. Before this, a Linux container
  // run (the repo is mounted read-write, so `tests/output/` lands back in the
  // host tree) wrote Linux PNGs into the cache a macOS run then read.
  describe("expectedCachePlatformDir", () => {
    it("gives each platform its own cache sub-directory", () => {
      const dirs = ["darwin", "linux", "win32"].map((p) => expectedCachePlatformDir(p));
      expect(new Set(dirs).size, "platforms must not share a cache directory").toBe(3);
    });

    it("does NOT give macOS the un-suffixed root (no platform is implicit)", () => {
      // Deliberate: an implicit root would keep the macOS cache hot across this
      // change, but it would also let entries a Linux run had ALREADY written
      // there survive the fix. Every platform is named, so the old flat entries
      // are simply never looked up again.
      expect(expectedCachePlatformDir("darwin")).not.toBe("");
      expect(expectedCachePlatformDir("darwin")).not.toBe(".");
    });

    it("is a single path segment (it is joined under `.expected-cache/`)", () => {
      for (const p of ["darwin", "linux", "win32"]) {
        expect(expectedCachePlatformDir(p)).not.toMatch(/[/\\]/);
      }
    });

    // DM-1797: `linux` alone is too coarse — the installed FONT SET is what
    // varies between Linux environments and what the screenshot depends on.
    // Deliberately not keyed on `linuxFontProfile()`: that is a two-way
    // noto/bare classification from a single Han-codepoint probe, so two images
    // can share a profile while differing in their Latin fonts.
    describe("Linux font-set digest (DM-1797)", () => {
      const withFingerprint = <T>(v: string | undefined, fn: () => T): T => {
        const prev = process.env.DOMOTION_FONT_FINGERPRINT;
        if (v == null) delete process.env.DOMOTION_FONT_FINGERPRINT;
        else process.env.DOMOTION_FONT_FINGERPRINT = v;
        __resetFontDigestForTest();
        try { return fn(); } finally {
          if (prev == null) delete process.env.DOMOTION_FONT_FINGERPRINT;
          else process.env.DOMOTION_FONT_FINGERPRINT = prev;
          __resetFontDigestForTest();
        }
      };

      it("suffixes ONLY linux — macOS and Windows keep the bare platform name", () => {
        withFingerprint("abc123", () => {
          expect(expectedCachePlatformDir("linux")).toBe("linux-abc123");
          expect(expectedCachePlatformDir("darwin")).toBe("darwin");
          expect(expectedCachePlatformDir("win32")).toBe("win32");
        });
      });

      it("two different font sets get two different cache directories", () => {
        const a = withFingerprint("fontsetA", () => expectedCachePlatformDir("linux"));
        const b = withFingerprint("fontsetB", () => expectedCachePlatformDir("linux"));
        expect(a).not.toBe(b);
      });

      it("is stable for one font set (a cache stays hot across runs)", () => {
        const a = withFingerprint("same", () => expectedCachePlatformDir("linux"));
        const b = withFingerprint("same", () => expectedCachePlatformDir("linux"));
        expect(a).toBe(b);
      });

      it("stays a single path segment", () => {
        withFingerprint(undefined, () => {
          expect(expectedCachePlatformDir("linux")).toMatch(/^linux-[0-9a-f]{8}$/);
        });
      });
    });
  });

  describe("harnessBrowserNote", () => {
    it("says nothing for the default configuration", () => {
      expect(harnessBrowserNote({ asymmetric: false, captureFlags: [], rasterFlags: [] })).toBeNull();
    });

    it("names both sides when asymmetric", () => {
      const note = harnessBrowserNote({ asymmetric: true, captureFlags: ["--x"], rasterFlags: [] });
      expect(note).toContain("ASYMMETRIC");
      expect(note).toContain("--x");
      expect(note).toContain("(none)");
    });

    it("warns that both sides move together when one browser is flagged", () => {
      const note = harnessBrowserNote({ asymmetric: false, captureFlags: ["--x"], rasterFlags: ["--x"] });
      expect(note).toContain("both sides move together");
    });
  });
});
