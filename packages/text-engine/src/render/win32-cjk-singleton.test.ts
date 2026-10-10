import { describe, expect, it } from "vitest";
import { win32CjkSingleton } from "./codepoint-resolver.js";

describe("Windows CJK compatibility normalization", () => {
  it("reduces canonical singleton ideographs used by the native Windows residual", () => {
    expect(win32CjkSingleton(0xf900)).toBe(0x8c48);
    expect(win32CjkSingleton(0xf91d)).toBe(0x6b04);
    expect(win32CjkSingleton(0xf9ff)).toBe(0x523a);
  });

  it("leaves ordinary Han, unrelated compatibility symbols, and non-singletons alone", () => {
    expect(win32CjkSingleton(0x8c48)).toBeNull();
    expect(win32CjkSingleton(0x212a)).toBeNull();
    expect(win32CjkSingleton(0xfa6e)).toBeNull();
  });
});
