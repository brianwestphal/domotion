/**
 * Lifecycle regressions from the stateful-module audit (DM-74V60G): memos that
 * the environment invalidation used to miss, and a platform-blind memo.
 */
import { afterEach, describe, expect, it } from "vitest";
import { invalidateFontEnvironmentCaches } from "./font-resolution.js";
import { __clearSystemUiFamilyForTest, __systemUiFamilyCacheForTest, resolveSystemUiFamily } from "./glyph-helper.js";
import { withHostPlatform } from "./host-platform.js";
import { __hintedOutlineGuardMemoSizeForTest, __seedHintedOutlineGuardForTest } from "./embedded-font-builder.js";
import { __linuxFontProfileMemoForTest, linuxFontProfile } from "./font-paths.linux.js";
import { __hbBufferSourceForTest, registerHbBufferSource } from "./harfbuzz-shaper.js";

afterEach(() => {
  __clearSystemUiFamilyForTest();
});

describe("resolveSystemUiFamily memo is Windows-only", () => {
  it("a darwin/linux call does not poison a later win32 call", () => {
    __clearSystemUiFamilyForTest();
    expect(withHostPlatform("darwin", () => resolveSystemUiFamily())).toBeNull();
    expect(withHostPlatform("linux", () => resolveSystemUiFamily())).toBeNull();
    // Nothing memoized: the win32 route will still ask the OS.
    expect(__systemUiFamilyCacheForTest()).toBeUndefined();
  });

  it("a memoized win32 answer is not served to another platform", () => {
    withHostPlatform("win32", () => resolveSystemUiFamily());
    const memo = __systemUiFamilyCacheForTest();
    expect(memo).not.toBeUndefined();
    expect(withHostPlatform("darwin", () => resolveSystemUiFamily())).toBeNull();
    // ...and the win32 memo survives the other platform's call.
    expect(__systemUiFamilyCacheForTest()).toBe(memo);
  });
});

describe("environment invalidation drops memos it used to miss", () => {
  it("hinted-outline guard verdicts (a file can be replaced at the same path)", () => {
    __seedHintedOutlineGuardForTest("/fake/font.ttf", 0, false);
    expect(__hintedOutlineGuardMemoSizeForTest()).toBeGreaterThan(0);
    invalidateFontEnvironmentCaches();
    expect(__hintedOutlineGuardMemoSizeForTest()).toBe(0);
  });

  it("the detected Linux font profile (a font install can change fontconfig's pick)", () => {
    const saved = process.env.DOMOTION_LINUX_FONT_PROFILE;
    process.env.DOMOTION_LINUX_FONT_PROFILE = "bare";
    try {
      invalidateFontEnvironmentCaches();
      expect(linuxFontProfile()).toBe("bare");
      expect(__linuxFontProfileMemoForTest()).toBe("bare");
      process.env.DOMOTION_LINUX_FONT_PROFILE = "noto";
      // Memoized within one environment...
      expect(linuxFontProfile()).toBe("bare");
      invalidateFontEnvironmentCaches();
      expect(__linuxFontProfileMemoForTest()).toBeNull();
      // ...and re-detected after it changes.
      expect(linuxFontProfile()).toBe("noto");
    } finally {
      if (saved == null) delete process.env.DOMOTION_LINUX_FONT_PROFILE;
      else process.env.DOMOTION_LINUX_FONT_PROFILE = saved;
      invalidateFontEnvironmentCaches();
    }
  });
});

describe("HarfBuzz buffer sources", () => {
  it("ids are stable per buffer identity and distinct across buffers", () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([1, 2, 3]);
    const idA = registerHbBufferSource(a);
    expect(registerHbBufferSource(a)).toBe(idA);
    const idB = registerHbBufferSource(b);
    expect(idB).not.toBe(idA);
    expect(__hbBufferSourceForTest(idA)).toBe(a);
    expect(__hbBufferSourceForTest(idB)).toBe(b);
  });
});
