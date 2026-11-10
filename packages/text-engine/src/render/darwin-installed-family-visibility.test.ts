import { afterEach, describe, expect, it, vi } from "vitest";

const inventory = vi.hoisted(() => ({ sfProInstalled: false }));
vi.mock("./glyph-helper.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./glyph-helper.js")>();
  const face = (name: string) => {
    if (/^(?:SF Pro|SFPro-Regular)$/i.test(name) && inventory.sfProInstalled)
      return { path: "/fixture/SFPro.ttf", postscriptName: "SFPro-Regular", familyName: "SF Pro" };
    if (/^(?:\.User Font|UserFont-Regular)$/i.test(name))
      return { path: "/fixture/User.ttf", postscriptName: "UserFont-Regular", familyName: ".User Font" };
    if (name === ".SF NS")
      return { path: "/fixture/Hidden.ttf", postscriptName: ".SFNS-Regular", familyName: ".SF NS" };
    return null;
  };
  return {
    ...actual,
    isGlyphHelperAvailable: () => false,
    resolveInstalledFont: (name: string) => face(name),
    resolveFamilyStyleMatch: (name: string) => {
      const matched = face(name);
      return matched == null ? null : { postscriptName: matched.postscriptName, weight: 400, italic: false };
    },
  };
});

import { matchFamilyNameToKey } from "./family-match.js";
import { withHostPlatform } from "./host-platform.js";
import { clearWebfonts, invalidateFontEnvironmentCaches, registerWebfont } from "./font-resolution.js";
import { buildVariableHintedFont } from "./synth-test-fonts.js";

afterEach(() => {
  clearWebfonts();
  inventory.sfProInstalled = false;
  invalidateFontEnvironmentCaches();
});

describe("installed family visibility follows the target platform", () => {
  it("walks past absent SF Pro rather than substituting the UI face", () => {
    withHostPlatform("darwin", () =>
      expect(matchFamilyNameToKey("sf pro", false, undefined, false, "SF Pro")).toBeNull(),
    );
  });
  it.each([".SF NS", ".User Font"])("rejects installed dot-prefixed %s on macOS", (family) => {
    withHostPlatform("darwin", () =>
      expect(matchFamilyNameToKey(family.toLowerCase(), false, undefined, false, family)).toBeNull(),
    );
  });
  it.each(["darwin", "linux", "win32"] as const)("keeps a genuinely installed SF Pro family on %s", (platform) => {
    inventory.sfProInstalled = true;
    withHostPlatform(platform, () =>
      expect(matchFamilyNameToKey("sf pro", false, undefined, false, "SF Pro")).toBe("sysfb:SFPro-Regular"),
    );
  });
  it.each(["linux", "win32"] as const)("does not impose the macOS dot-name gate on %s", (platform) => {
    withHostPlatform(platform, () =>
      expect(matchFamilyNameToKey(".user font", false, undefined, false, ".User Font")).toBe("sysfb:UserFont-Regular"),
    );
  });
  it.each(["SF Pro", ".SF NS"])("preserves real registered author bytes named %s", (family) => {
    registerWebfont(family, 400, "normal", buildVariableHintedFont());
    withHostPlatform("darwin", () =>
      expect(matchFamilyNameToKey(family.toLowerCase(), false, undefined, false, family)).toBe(
        `webfont:${family.toLowerCase()}`,
      ),
    );
  });
  it("preserves macOS system-ui and BlinkMacSystemFont dispatch", () => {
    withHostPlatform("darwin", () => {
      expect(matchFamilyNameToKey("system-ui", true, undefined, true)).toBe("sf-pro");
      expect(matchFamilyNameToKey("blinkmacsystemfont", false)).toBe("sf-pro");
    });
  });
});
