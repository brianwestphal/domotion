import { describe, expect, it } from "vitest";
import { chromeFontAgreement } from "../tools/chrome-font-agreement.js";
import { compareGlyphs } from "../tools/compare-glyphs.js";

describe("migrated positional tools", () => {
  it("rejects unknown flags and excess operands before starting browser or image work", async () => {
    await expect(chromeFontAgreement(["--typo"])).rejects.toThrow();
    await expect(chromeFontAgreement(["serif", "41", "extra"])).rejects.toThrow();
    await expect(compareGlyphs(["a.png", "b.png", "--typo"])).rejects.toThrow();
    await expect(compareGlyphs(["a.png", "b.png", "--rect-a"])).rejects.toThrow();
    await expect(compareGlyphs(["a.png"])).rejects.toThrow(/usage/);
  });
});
