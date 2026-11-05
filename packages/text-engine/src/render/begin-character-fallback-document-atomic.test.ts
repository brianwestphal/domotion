import { afterEach, describe, expect, it, vi } from "vitest";

// Make the LAST step of opening a document (the CoreText owner selection)
// throw on demand, after the caches, the darwin lifetime and the Linux renderer
// scope have all been opened.
const fault = vi.hoisted(() => ({ throwOnSelect: false }));

vi.mock("./glyph-helper.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./glyph-helper.js")>();
  return {
    ...actual,
    selectCoreTextFallbackOwner: (...args: Parameters<typeof actual.selectCoreTextFallbackOwner>) => {
      if (fault.throwOnSelect) throw new Error("owner selection failed");
      return actual.selectCoreTextFallbackOwner(...args);
    },
  };
});

const {
  __characterFallbackDocumentCacheForTest,
  __characterFallbackDocumentDepthForTest,
  beginCharacterFallbackDocument,
  endCharacterFallbackDocument,
} = await import("./character-fallback-cache.js");
const { __fcFallbackRendererCacheForTest } = await import("./glyph-helper.js");
const { __darwinFontDataDocumentOpenForTest } = await import("./darwin-font-data-lifetime.js");
const { withHostPlatform } = await import("./host-platform.js");

afterEach(() => {
  fault.throwOnSelect = false;
  while (__characterFallbackDocumentDepthForTest() > 0) endCharacterFallbackDocument();
});

describe("beginCharacterFallbackDocument is atomic (DM-74V60G)", () => {
  it("a throw while opening leaves no partial document state behind", () => {
    withHostPlatform("darwin", () => {
      fault.throwOnSelect = true;
      expect(() => beginCharacterFallbackDocument()).toThrow("owner selection failed");
      expect(__characterFallbackDocumentDepthForTest()).toBe(0);
      expect(__characterFallbackDocumentCacheForTest()).toBeNull();
      expect(__darwinFontDataDocumentOpenForTest()).toBe(false);
      expect(__fcFallbackRendererCacheForTest()).toBeNull();
    });
  });

  it("fail → succeed: the next begin opens a clean document", () => {
    fault.throwOnSelect = true;
    expect(() => beginCharacterFallbackDocument()).toThrow();
    fault.throwOnSelect = false;
    beginCharacterFallbackDocument();
    expect(__characterFallbackDocumentDepthForTest()).toBe(1);
    expect(__characterFallbackDocumentCacheForTest()!.size).toBe(0);
    expect(__fcFallbackRendererCacheForTest()).not.toBeNull();
    endCharacterFallbackDocument();
    expect(__fcFallbackRendererCacheForTest()).toBeNull();
  });

  it("a nested begin never re-runs the opening steps, so it cannot fail them", () => {
    beginCharacterFallbackDocument();
    fault.throwOnSelect = true;
    expect(() => beginCharacterFallbackDocument()).not.toThrow();
    expect(__characterFallbackDocumentDepthForTest()).toBe(2);
    endCharacterFallbackDocument();
    endCharacterFallbackDocument();
    expect(__characterFallbackDocumentDepthForTest()).toBe(0);
  });
});
