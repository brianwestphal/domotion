import { afterEach, describe, expect, it } from "vitest";
import { declaredFamilyForKey } from "./family-match.js";
import { dynamicSystemFontPaths, registerDynamicSystemFont } from "./font-paths.win32.js";
import { withHostPlatform } from "./host-platform.js";
import { resolveFontSpec } from "./font-spec.js";
import { exactDarwinFallbackKey } from "./system-fallback-resolver.js";

const nominated = "sysfb:TestFace-Regular";
const exact = "sysfb:exact:TestFace-Regular";

afterEach(() => {
  declaredFamilyForKey.delete(nominated);
  dynamicSystemFontPaths.delete(nominated);
  dynamicSystemFontPaths.delete(exact);
});

describe("exact Darwin fallback key", () => {
  it("keeps a CoreText nominated face separate when a declared primary later claims its key", () => {
    registerDynamicSystemFont(nominated, "test-face.ttc", "TestFace-Regular", "native", undefined, [
      { tag: "wght", min: 100, def: 400, max: 900, value: 400 },
    ]);
    withHostPlatform("darwin", () => {
      expect(exactDarwinFallbackKey(nominated)).toBe(nominated);
      declaredFamilyForKey.set(nominated, "Test Face");
      expect(exactDarwinFallbackKey(nominated)).toBe(exact);
      expect(exactDarwinFallbackKey(nominated)).toBe(exact);
      expect(resolveFontSpec(exact)).toEqual(resolveFontSpec(nominated));
      declaredFamilyForKey.delete(nominated);
      expect(exactDarwinFallbackKey(nominated)).toBe(nominated);
    });
  });

  it("preserves other platforms and non-system fallback keys", () => {
    registerDynamicSystemFont(nominated, "test-face.ttc", "TestFace-Regular");
    declaredFamilyForKey.set(nominated, "Test Face");
    expect(withHostPlatform("linux", () => exactDarwinFallbackKey(nominated))).toBe(nominated);
    expect(withHostPlatform("win32", () => exactDarwinFallbackKey(nominated))).toBe(nominated);
    expect(withHostPlatform("darwin", () => exactDarwinFallbackKey("times"))).toBe("times");
  });
});
