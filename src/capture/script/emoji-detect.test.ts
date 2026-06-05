import { describe, it, expect } from "vitest";
import { createEmojiDetect } from "./emoji-detect.js";

// `needsRaster` decides whether a codepoint must be rasterized as a color-emoji
// `<image>` overlay instead of a path glyph. The branches exercised here are the
// UNCONDITIONAL ones (set membership / range), which take no DOM — they return
// before the `isColorGlyph` canvas probe. The cascade-dependent branches (bare
// `emojiBaseCps` → `isColorGlyph`) need a real browser, so they're covered by
// the html-test-unicode visual fixtures (2700-27BF-dingbats, 1F100-1F1FF), not
// here. See the CAPTURE_SCRIPT discipline note in CLAUDE.md.
describe("emoji-detect needsRaster (unconditional branches)", () => {
  const { needsRaster } = createEmojiDetect();

  it("rasters the default-emoji-presentation Dingbats no text font covers", () => {
    // ✅ ✊ ✋ — Emoji_Presentation=Yes, painted color regardless of cascade.
    // Were dropped to an empty path glyph before being added to rasterCps.
    expect(needsRaster(0x2705, 0, "x")).toBe(true);
    expect(needsRaster(0x270A, 0, "x")).toBe(true);
    expect(needsRaster(0x270B, 0, "x")).toBe(true);
  });

  it("rasters the squared Enclosed Alphanumeric Supplement emoji (🆎 🆑–🆚)", () => {
    // These sit BELOW the 0x1F300 main-block floor, so they need their own gate.
    expect(needsRaster(0x1F18E, 0, "x")).toBe(true); // 🆎
    expect(needsRaster(0x1F191, 0, "x")).toBe(true); // 🆑
    expect(needsRaster(0x1F195, 0, "x")).toBe(true); // 🆕
    expect(needsRaster(0x1F19A, 0, "x")).toBe(true); // 🆚
  });

  it("keeps the pre-existing unconditional families and ranges", () => {
    expect(needsRaster(0x2716, 0, "x")).toBe(true);  // rasterCps ✖
    expect(needsRaster(0x1F1E6, 0, "x")).toBe(true); // regional indicator
    expect(needsRaster(0x1F600, 0, "x")).toBe(true); // 1F300–1FAFF main block
  });

  it("does NOT raster non-emoji symbols / arrows / enclosed letters", () => {
    expect(needsRaster(0x2701, 0, "x")).toBe(false); // ✁ scissors (path glyph)
    expect(needsRaster(0x2190, 0, "x")).toBe(false); // ← arrow
    expect(needsRaster(0x1F100, 0, "x")).toBe(false); // 🄀 (mono, below squared range)
    expect(needsRaster(0x1F18F, 0, "x")).toBe(false); // gap just past 🆎
    expect(needsRaster(0x1F19B, 0, "x")).toBe(false); // just past 🆚
  });
});
