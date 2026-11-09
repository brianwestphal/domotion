import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FontInstance } from "./font-instance.js";
const boundary = vi.hoisted(() => ({ call: vi.fn(), available: vi.fn(), source: vi.fn() }));
vi.mock("./glyph-helper-transport.js", () => ({
  callGlyphHelper: boundary.call,
  isGlyphHelperAvailable: boundary.available,
}));
vi.mock("./font-instance.js", () => ({ getFontSourceInfo: boundary.source }));
import {
  linuxFontEnvironmentKey,
  linuxFontRenderStyle,
  type LinuxFontRenderContext,
} from "./linux-font-render-style.js";

const context = (singleProcess = false): LinuxFontRenderContext => ({
  source: "shared-fontconfig-v1",
  environmentKey: linuxFontEnvironmentKey(),
  singleProcess,
  launchHinting: "none",
  deviceScaleFactor: 1,
  disableSubpixelPositioning: false,
});
const request = { fontFamily: "Control", fontSize: 16, fontWeight: 900, italic: true };
const face = (): FontInstance => ({ postscriptName: "Control" }) as FontInstance;
const selected = {
  type: "familyMatch",
  found: true,
  path: "control.ttf",
  postscriptName: "Control",
  weight: 400,
  italic: false,
};
const style = { type: "fontRenderStyle", hinting: "medium", forceAutoHint: false, environment: process.env };
beforeEach(() => {
  boundary.call.mockReset();
  boundary.available.mockReset().mockReturnValue(true);
  boundary.source.mockReset().mockReturnValue({ path: "control.ttf", nameMatched: true });
});

describe("Linux effective font style", () => {
  it("uses selected typeface traits and per-face Fontconfig over the launch preference", () => {
    boundary.call.mockReturnValueOnce({ results: [selected] }).mockReturnValue({ results: [style] });
    const font = face();
    expect(linuxFontRenderStyle(font, request, context())).toEqual({ hinting: "medium", forceAutoHint: false });
    expect(linuxFontRenderStyle(font, request, context())).toEqual({ hinting: "medium", forceAutoHint: false });
    expect(boundary.call).toHaveBeenCalledTimes(2);
    expect(boundary.call.mock.calls[1][0].queries[0]).toMatchObject({
      family: "Control",
      bold: false,
      italic: false,
      fontSizePx: 16,
    });
  });
  it("uses the global empty query in single process, retaining independent autohint", () => {
    boundary.call.mockReturnValue({ results: [{ ...style, forceAutoHint: true }] });
    expect(linuxFontRenderStyle(face(), request, context(true))).toEqual({ hinting: "none", forceAutoHint: true });
    expect(boundary.call.mock.calls[0][0].queries[0].family).toBeUndefined();
  });
  it("rejects missing launch/environment/helper evidence", () => {
    expect(linuxFontRenderStyle(face(), request, undefined)).toBeNull();
    expect(linuxFontRenderStyle(face(), request, { ...context(), environmentKey: "other" })).toBeNull();
    boundary.available.mockReturnValue(false);
    expect(linuxFontRenderStyle(face(), request, context())).toBeNull();
    expect(boundary.call).not.toHaveBeenCalled();
  });
  it("rejects stale native environments, unavailable old-helper fields and identity mismatch", () => {
    for (const response of [
      { ...style, environment: {} },
      { type: "fontRenderStyle", error: "unknown query" },
      { ...style, forceAutoHint: undefined },
    ]) {
      boundary.call
        .mockReset()
        .mockReturnValueOnce({ results: [selected] })
        .mockReturnValue({ results: [response] });
      expect(linuxFontRenderStyle(face(), request, context())).toBeNull();
    }
    boundary.call.mockReset().mockReturnValue({ results: [{ ...selected, path: "other.ttf" }] });
    expect(linuxFontRenderStyle(face(), request, context())).toBeNull();
  });
  it("does not skip an unverified earlier alternate-name nomination", () => {
    boundary.call
      .mockReturnValueOnce({ results: [{ type: "familyMatch", found: false }] })
      .mockReturnValueOnce({ results: [selected] })
      .mockReturnValue({ results: [style] });
    expect(linuxFontRenderStyle(face(), { ...request, fontFamily: "Alias, Control" }, context())).toBeNull();
    expect(boundary.call).toHaveBeenCalledOnce();
  });

  it("keeps generics without nomination provenance and failed queries conservative", () => {
    expect(linuxFontRenderStyle(face(), { ...request, fontFamily: "serif" }, context())).toBeNull();
    boundary.call.mockImplementation(() => {
      throw new Error("unavailable");
    });
    expect(linuxFontRenderStyle(face(), request, context())).toBeNull();
  });
});
