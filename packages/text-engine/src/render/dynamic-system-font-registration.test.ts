import { afterEach, describe, expect, it, vi } from "vitest";

// Host-independent stand-in for the installed SF Pro Text OTF, so the coverage-memo transition runs on
// every platform. `null` models "not installed on this host".
const installed = vi.hoisted(() => ({
  sfPro: { path: "/fake/SF-Pro-Text-Regular.otf", postscriptName: "SFProText-Regular" } as {
    path: string;
    postscriptName: string;
  } | null,
}));

vi.mock("./glyph-helper.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./glyph-helper.js")>();
  return {
    ...actual,
    resolveInstalledFont: (name: string, ...rest: unknown[]) =>
      name === "SF Pro Text"
        ? installed.sfPro && { ...installed.sfPro }
        : (actual.resolveInstalledFont as (...args: unknown[]) => unknown)(name, ...rest),
  };
});

const { clearFontResolutionCaches, invalidateFontEnvironmentCaches, resolveFontSpec } =
  await import("./font-resolution.js");
const { registerDynamicSystemFont, resolvedSpecCache } = await import("./font-paths.win32.js");
const { sfProCoverageOtfKey } = await import("./shaping-route.js");
const { withHostPlatform } = await import("./host-platform.js");

afterEach(() => {
  installed.sfPro = { path: "/fake/SF-Pro-Text-Regular.otf", postscriptName: "SFProText-Regular" };
  invalidateFontEnvironmentCaches();
});

describe("registerDynamicSystemFont evicts a cached null (DM-C32SHD: the delete used the unprefixed key)", () => {
  for (const platform of ["darwin", "linux", "win32"] as const) {
    it(`null → register → resolves, under ${platform}`, () => {
      const key = `sysfb:DmC32shdProbe-${platform}`;
      withHostPlatform(platform, () => {
        expect(resolveFontSpec(key)).toBeNull();
        registerDynamicSystemFont(key, `/fake/${platform}.ttf`, `DmC32shdProbe-${platform}`, "fontkit");
        expect(resolveFontSpec(key)?.path).toBe(`/fake/${platform}.ttf`);
      });
    });
  }

  it("evicts the cached null for every platform that asked, not only the current one", () => {
    const key = "sysfb:DmC32shdProbe-all";
    for (const platform of ["darwin", "linux", "win32"] as const) {
      withHostPlatform(platform, () => expect(resolveFontSpec(key)).toBeNull());
    }
    registerDynamicSystemFont(key, "/fake/all.ttf", "DmC32shdProbe-all", "fontkit");
    for (const platform of ["darwin", "linux", "win32"] as const) {
      withHostPlatform(platform, () => expect(resolveFontSpec(key)?.path).toBe("/fake/all.ttf"));
    }
  });

  it("does not evict a different key that merely shares a suffix", () => {
    const other = "sysfb:DmC32shdProbe-suffix-other";
    expect(resolveFontSpec(other)).toBeNull();
    const sizeBefore = resolvedSpecCache.size;
    registerDynamicSystemFont("DmC32shdProbe-suffix-other", "/fake/x.ttf", "X", "fontkit");
    expect(resolvedSpecCache.size).toBe(sizeBefore);
  });

  it("re-registering an already-registered key is a no-op (first registration wins)", () => {
    const key = "sysfb:DmC32shdProbe-idem";
    registerDynamicSystemFont(key, "/fake/first.ttf", "First", "fontkit");
    expect(resolveFontSpec(key)?.path).toBe("/fake/first.ttf");
    registerDynamicSystemFont(key, "/fake/second.ttf", "Second", "fontkit");
    expect(resolveFontSpec(key)?.path).toBe("/fake/first.ttf");
  });

  it("a registered key survives a memory trim but not an environment invalidation", () => {
    const key = "sysfb:DmC32shdProbe-trim";
    registerDynamicSystemFont(key, "/fake/trim.ttf", "Trim", "fontkit");
    clearFontResolutionCaches();
    expect(resolveFontSpec(key)?.path).toBe("/fake/trim.ttf");
    invalidateFontEnvironmentCaches();
    expect(resolveFontSpec(key)).toBeNull();
    // ...and a re-registration after invalidation is observed despite the cached null.
    registerDynamicSystemFont(key, "/fake/trim2.ttf", "Trim", "fontkit");
    expect(resolveFontSpec(key)?.path).toBe("/fake/trim2.ttf");
  });
});

describe("sfProCoverageOtfKey is reset by invalidateFontEnvironmentCaches (DM-C32SHD)", () => {
  it("key → invalidate → key still resolves", () => {
    const key = sfProCoverageOtfKey();
    expect(key).toBe("sysfb:SFProText-Regular");
    expect(resolveFontSpec(key!)?.path).toBe("/fake/SF-Pro-Text-Regular.otf");
    invalidateFontEnvironmentCaches();
    const again = sfProCoverageOtfKey();
    expect(again).toBe(key);
    expect(resolveFontSpec(again!)?.path).toBe("/fake/SF-Pro-Text-Regular.otf");
  });

  it("a memoized 'not installed' is re-derived after invalidation (installed later)", () => {
    installed.sfPro = null;
    invalidateFontEnvironmentCaches();
    expect(sfProCoverageOtfKey()).toBeNull();
    installed.sfPro = { path: "/fake/later.otf", postscriptName: "SFProText-Regular" };
    // Still memoized until the environment is invalidated.
    expect(sfProCoverageOtfKey()).toBeNull();
    invalidateFontEnvironmentCaches();
    expect(resolveFontSpec(sfProCoverageOtfKey()!)?.path).toBe("/fake/later.otf");
  });

  it("an installed face removed by the environment change is forgotten (installed → removed)", () => {
    expect(sfProCoverageOtfKey()).not.toBeNull();
    installed.sfPro = null;
    invalidateFontEnvironmentCaches();
    expect(sfProCoverageOtfKey()).toBeNull();
  });

  it("survives a memory trim unchanged", () => {
    const key = sfProCoverageOtfKey();
    clearFontResolutionCaches();
    expect(sfProCoverageOtfKey()).toBe(key);
    expect(resolveFontSpec(key!)).not.toBeNull();
  });
});
