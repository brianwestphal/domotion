import { afterEach, describe, expect, it } from "vitest";
import { declaredFamilyForKey } from "./family-match.js";
import { dynamicSystemFontPaths, registerDynamicSystemFont } from "./font-paths.win32.js";
import { withHostPlatform } from "./host-platform.js";
import { resolveFontSpec } from "./font-spec.js";
import { exactSystemFallbackKey } from "./system-fallback-resolver.js";

const nominated = "sysfb:TestFace-Regular";
const exact = "sysfb:exact:TestFace-Regular";

afterEach(() => {
  declaredFamilyForKey.delete(nominated);
  dynamicSystemFontPaths.delete(nominated);
  dynamicSystemFontPaths.delete(exact);
});

describe("exact system fallback key", () => {
  it("keeps a CoreText nominated face separate when a declared primary later claims its key", () => {
    registerDynamicSystemFont(nominated, "test-face.ttc", "TestFace-Regular", "native", undefined, [
      { tag: "wght", min: 100, def: 400, max: 900, value: 400 },
    ]);
    withHostPlatform("darwin", () => {
      expect(exactSystemFallbackKey(nominated)).toBe(nominated);
      declaredFamilyForKey.set(nominated, "Test Face");
      expect(exactSystemFallbackKey(nominated)).toBe(exact);
      expect(exactSystemFallbackKey(nominated)).toBe(exact);
      expect(resolveFontSpec(exact)).toEqual(resolveFontSpec(nominated));
      declaredFamilyForKey.delete(nominated);
      expect(exactSystemFallbackKey(nominated)).toBe(nominated);
    });
  });

  it("keeps a DirectWrite nominated face separate from a declared family that shares its key", () => {
    registerDynamicSystemFont(nominated, "C:\\Windows\\Fonts\\testface.ttf", "TestFace-Regular");
    withHostPlatform("win32", () => {
      expect(exactSystemFallbackKey(nominated)).toBe(nominated);
      declaredFamilyForKey.set(nominated, "Test Face");
      expect(exactSystemFallbackKey(nominated)).toBe(exact);
      expect(resolveFontSpec(exact)).toEqual(resolveFontSpec(nominated));
      expect(declaredFamilyForKey.has(exact)).toBe(false);
    });
  });

  it("preserves Linux and non-system fallback keys", () => {
    registerDynamicSystemFont(nominated, "test-face.ttc", "TestFace-Regular");
    declaredFamilyForKey.set(nominated, "Test Face");
    expect(withHostPlatform("linux", () => exactSystemFallbackKey(nominated))).toBe(nominated);
    expect(withHostPlatform("darwin", () => exactSystemFallbackKey("times"))).toBe("times");
    expect(withHostPlatform("win32", () => exactSystemFallbackKey("times"))).toBe("times");
  });
});
