import { describe, expect, it } from "vitest";
import {
  coveredFontResolution,
  fontInstanceCacheKey,
  genericSettingsFamilyName,
} from "./font-resolution.js";

describe("fontInstanceCacheKey", () => {
  it("canonicalizes variation-axis insertion order", () => {
    const a = fontInstanceCacheKey("face", 400, 16, 0, { wght: 500, opsz: 16 }, false, "Face", 100);
    const b = fontInstanceCacheKey("face", 400, 16, 0, { opsz: 16, wght: 500 }, false, "Face", 100);
    expect(a).toBe(b);
  });

  it("keeps system-ui, declared-family, and width routes distinct", () => {
    const declared = fontInstanceCacheKey("sf-pro", 400, 16, 0, undefined, false, "SF Pro Text", 100);
    const system = fontInstanceCacheKey("sf-pro", 400, 16, 0, undefined, true, undefined, 100);
    const condensed = fontInstanceCacheKey("sf-pro", 400, 16, 0, undefined, true, undefined, 75);
    expect(new Set([declared, system, condensed])).toHaveLength(3);
  });

  it("keeps logical optical-size requests distinct at the same computed size", () => {
    const request = (logical: number) => {
      const axes = {};
      Object.defineProperty(axes, "__dmLogicalFontSize", { value: logical, enumerable: false });
      Object.defineProperty(axes, "__dmComputedFontSize", { value: 26, enumerable: false });
      return fontInstanceCacheKey("sf-pro", 400, 26, 0, axes, true, undefined, 100);
    };
    expect(request(13)).not.toBe(request(26));
  });
});

describe("genericSettingsFamilyName", () => {
  it.each(["-webkit-standard", "-webkit-body"])("maps %s to Blink's standard setting", (name) => {
    expect(genericSettingsFamilyName(name)).toBe("standard");
  });

  it("preserves every other family candidate", () => {
    expect(genericSettingsFamilyName("sans-serif")).toBe("sans-serif");
  });
});

describe("coveredFontResolution", () => {
  it("centralizes the successful fallback-stage wire shape", () => {
    expect(coveredFontResolution("fallback", null, "x", true)).toEqual({
      key: "fallback", fontOverride: null, emitCh: "x", decomposed: true,
      covered: true,
    });
  });
});
