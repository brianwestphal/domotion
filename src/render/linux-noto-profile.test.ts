/**
 * DM-1404: desktop-Linux Noto font profile. `linuxFallbackChain` and the profile
 * detector are platform-agnostic functions (they don't gate on
 * `process.platform`), so they're exercised directly here on any host. The
 * profile is forced via `DOMOTION_LINUX_FONT_PROFILE` so the test is
 * deterministic regardless of the host's fontconfig. Routing only — no font
 * extraction (the Noto files exist only on a Noto Linux host; end-to-end
 * resolution is verified in the Docker calibration env).
 */
import { afterEach, describe, expect, it } from "vitest";
import { linuxFallbackChain, __linuxFontProfileForTest, __resetLinuxFontProfileForTest } from "./text-to-path.js";
import { UNICODE_FONT_PATHS_NOTO_LINUX, UNICODE_FONT_RANGES_NOTO_LINUX } from "./unicode-font-routing.noto-linux.generated.js";

function withProfile<T>(profile: "noto" | "bare", fn: () => T): T {
  const prev = process.env.DOMOTION_LINUX_FONT_PROFILE;
  process.env.DOMOTION_LINUX_FONT_PROFILE = profile;
  __resetLinuxFontProfileForTest();
  try { return fn(); }
  finally {
    if (prev == null) delete process.env.DOMOTION_LINUX_FONT_PROFILE;
    else process.env.DOMOTION_LINUX_FONT_PROFILE = prev;
    __resetLinuxFontProfileForTest();
  }
}

describe("Linux Noto font profile (DM-1404)", () => {
  afterEach(() => __resetLinuxFontProfileForTest());

  it("detects the forced profile", () => {
    expect(withProfile("noto", () => __linuxFontProfileForTest())).toBe("noto");
    expect(withProfile("bare", () => __linuxFontProfileForTest())).toBe("bare");
  });

  it("routes CJK / scripts through the generated Noto table under the noto profile", () => {
    withProfile("noto", () => {
      // Han, Hiragana → Noto Sans CJK (jp member).
      expect(linuxFallbackChain(0x4e00)).toEqual(["un-noto-sans-cjk-jp"]);
      expect(linuxFallbackChain(0x3042)).toEqual(["un-noto-sans-cjk-jp"]);
      // Thai, Devanagari, Arabic → their Noto script faces.
      expect(linuxFallbackChain(0x0e01)).toEqual(["un-noto-sans-thai"]);
      expect(linuxFallbackChain(0x0905)).toEqual(["un-noto-sans-devanagari"]);
      expect(linuxFallbackChain(0x0671)[0]).toMatch(/^un-noto-(naskh-arabic|kufi-arabic)/);
    });
  });

  it("falls back to the bare WenQuanYi/FreeFont routes under the bare profile", () => {
    withProfile("bare", () => {
      // Hebrew → helvetica (Liberation Sans), Arabic → sf-arabic (FreeSerif) — the
      // bare-image hand routes, NOT the un-... Noto keys.
      expect(linuxFallbackChain(0x05d0)).toEqual(["helvetica"]);
      expect(linuxFallbackChain(0x0600)).toEqual(["sf-arabic"]);
      // CJK → the bare "cjk" key (WenQuanYi), not un-noto-sans-cjk-jp.
      expect(linuxFallbackChain(0x4e00)).toEqual(["cjk"]);
    });
  });

  it("every generated Noto range key has a path entry (well-formed table)", () => {
    const keys = new Set(Object.keys(UNICODE_FONT_PATHS_NOTO_LINUX));
    const missing = UNICODE_FONT_RANGES_NOTO_LINUX.filter(([, , k]) => !keys.has(k)).map(([, , k]) => k);
    expect(missing).toEqual([]);
    // Ranges are sorted by start and non-overlapping (binary search precondition).
    let prevEnd = -1;
    for (const [start, end] of UNICODE_FONT_RANGES_NOTO_LINUX) {
      expect(start).toBeGreaterThan(prevEnd);
      expect(end).toBeGreaterThanOrEqual(start);
      prevEnd = end;
    }
  });
});
