import { afterEach, describe, expect, it, vi } from "vitest";

const callGlyphHelper = vi.hoisted(() => vi.fn());

vi.mock("./host-platform.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./host-platform.js")>()),
  hostPlatform: () => "darwin" as const,
}));

vi.mock("./glyph-helper-transport.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./glyph-helper-transport.js")>()),
  callGlyphHelper,
  isGlyphHelperAvailable: () => true,
}));

import {
  clearGlyphHelperCache,
  resolveFamilyStyleMatch,
  resolveFamilyStyleMatchWithStatus,
  resolveInstalledFont,
} from "./glyph-helper.js";
import { __darwinPrimaryCutKeyForTest, clearFontResolutionCaches } from "./font-resolution.js";

describe("declared-family match retry", () => {
  afterEach(() => {
    clearGlyphHelperCache();
    clearFontResolutionCaches();
    callGlyphHelper.mockReset();
  });

  it("does not cache a transient helper exception and caches the later valid answer", () => {
    callGlyphHelper
      .mockImplementationOnce(() => {
        throw new Error("transient spawn failure");
      })
      .mockReturnValue({
        results: [
          {
            type: "familyMatch",
            found: true,
            postscriptName: "PingFangSC-Regular",
            weight: 400,
            candidates: [{ name: "PingFangSC-Regular", traits: 0 }],
          },
        ],
      });

    expect(resolveFamilyStyleMatchWithStatus("PingFang SC", { weight: 400 })).toEqual({
      match: {
        postscriptName: "PingFangSC-Regular",
        weight: 400,
        italic: false,
      },
      cacheable: true,
    });
    expect(resolveFamilyStyleMatch("PingFang SC", { weight: 400 })).toEqual({
      postscriptName: "PingFangSC-Regular",
      weight: 400,
      italic: false,
    });
    expect(resolveFamilyStyleMatch("PingFang SC", { weight: 400 })).toEqual({
      postscriptName: "PingFangSC-Regular",
      weight: 400,
      italic: false,
    });
    expect(callGlyphHelper).toHaveBeenCalledTimes(2);
  });

  it("does not let the declared-family memo turn a transient failure into a permanent fallback", () => {
    callGlyphHelper.mockImplementation(() => {
      throw new Error("transient spawn failure");
    });

    const resolve = () => __darwinPrimaryCutKeyForTest("pingfang-sc", 400, 0, 100, "PingFang SC");
    expect(resolve()).toBeNull();

    callGlyphHelper.mockReturnValue({
      results: [
        {
          type: "familyMatch",
          found: true,
          postscriptName: "PingFangSC-Regular",
          weight: 400,
          candidates: [{ name: "PingFangSC-Regular", traits: 0 }],
        },
      ],
    });

    expect(resolve()).toEqual({ key: "pingfang-sc", italic: false });
    expect(resolve()).toEqual({ key: "pingfang-sc", italic: false });
    expect(callGlyphHelper.mock.calls.filter(([request]) => request.queries?.[0]?.type === "familyMatch")).toHaveLength(
      7,
    );
  });

  it("canonicalizes duplicate macOS PingFang names to the reserved Chrome source", () => {
    callGlyphHelper.mockReturnValue({
      results: [
        {
          type: "family",
          found: true,
          postscriptName: "PingFangSC-Regular",
          familyName: "PingFang SC",
          path: "/System/Library/AssetsV2/example.asset/AssetData/PingFang.ttc",
        },
      ],
    });

    expect(resolveInstalledFont("PingFangSC-Regular")?.path).toContain("/Reserved/PingFangUI.ttc");
  });
});
