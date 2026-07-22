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

  it("rasters the Enclosed Ideographic Supplement emoji (🈁 🈚 🈯 🈲–🈺 🉐 🉑) — DM-1110", () => {
    // U+1F200-1F2FF squared/circled CJK emoji below the 0x1F300 floor that
    // Chrome paints via Apple Color Emoji. Mix of Emoji_Presentation=Yes and the
    // three text-default ones (1F201/1F202/1F237) no macOS text font covers.
    expect(needsRaster(0x1F201, 0, "x")).toBe(true); // 🈁
    expect(needsRaster(0x1F202, 0, "x")).toBe(true); // 🈂
    expect(needsRaster(0x1F21A, 0, "x")).toBe(true); // 🈚
    expect(needsRaster(0x1F22F, 0, "x")).toBe(true); // 🈯
    expect(needsRaster(0x1F232, 0, "x")).toBe(true); // 🈲
    expect(needsRaster(0x1F237, 0, "x")).toBe(true); // 🈷 (text-default, folded into the run)
    expect(needsRaster(0x1F23A, 0, "x")).toBe(true); // 🈺
    expect(needsRaster(0x1F250, 0, "x")).toBe(true); // 🉐
    expect(needsRaster(0x1F251, 0, "x")).toBe(true); // 🉑
  });

  it("does NOT raster the monochrome (text-presentation) 1F200 cells — DM-1110", () => {
    // Squared/bracketed CJK that Chrome paints as a monochrome text glyph, NOT
    // color — they stay on the path pipeline (verified per-cell against Chrome's
    // paint for the 1F200 fixture).
    expect(needsRaster(0x1F200, 0, "x")).toBe(false); // 🈀
    expect(needsRaster(0x1F210, 0, "x")).toBe(false); // 🈐 squared CJK
    expect(needsRaster(0x1F22E, 0, "x")).toBe(false); // just below 🈯
    expect(needsRaster(0x1F23B, 0, "x")).toBe(false); // just past 🈺
    expect(needsRaster(0x1F240, 0, "x")).toBe(false); // 🉀 tortoise-shell bracket
    expect(needsRaster(0x1F252, 0, "x")).toBe(false); // just past 🉑
  });

  it("keeps the pre-existing unconditional families and ranges", () => {
    // ✖ U+2716 moved from unconditional rasterCps to the cascade-probed
    // checksCrossesCps set (fill-invariance probe): in a happy-dom test there
    // is no canvas, so the probe's fail-safe returns true (keep rastering).
    expect(needsRaster(0x2716, 0, "x")).toBe(true);  // checksCrossesCps ✖ (fail-safe)
    expect(needsRaster(0x1F1E6, 0, "x")).toBe(true); // regional indicator
    expect(needsRaster(0x1F600, 0, "x")).toBe(true); // 1F300–1FAFF main block
  });

  it("does NOT widen past the Alchemical block — neighbors still raster unconditionally (DM-1125)", () => {
    // The DM-1125 carve-out gates ONLY U+1F700-1F77F through the cascade probe.
    // The codepoints immediately outside it are genuine color emoji that NO text
    // font covers, so they must keep returning the unconditional `true` from the
    // 0x1F300-0x1FAFF main-block branch — guards against the carve-out range
    // being accidentally widened and silently dropping real emoji to a tofu path.
    expect(needsRaster(0x1F6FF, 0, "x")).toBe(true); // just below the block
    expect(needsRaster(0x1F780, 0, "x")).toBe(true); // just above the block (Geometric Shapes Extended)
    // In-range with no font context falls back to the raster fail-safe (the
    // `isColorGlyph` early return) — the MONOCHROME → path outcome is cascade-
    // dependent and covered by tests/alchemical-symbols-not-rastered.e2e.test.ts
    // plus the html-test-unicode 1F700-1F77F-alchemical-symbols visual fixture.
    expect(needsRaster(0x1F770, 0, "")).toBe(true);
  });

  it("rasters the Enclosed CJK emoji-presentation pair ㊗ ㊙ via the cascade probe — DM-1168", () => {
    // U+3297 / U+3299 are Emoji_Presentation=Yes; Chrome paints them color by
    // default but Hiragino / Arial Unicode cover them as monochrome, so the
    // branch is cascade-gated (`isColorGlyph`). With no font context the probe
    // short-circuits to the raster fail-safe — the MONOCHROME → path outcome is
    // covered by the 3200-32FF-enclosed-cjk-letters-and-months visual fixture.
    expect(needsRaster(0x3297, 0, "")).toBe(true); // ㊗
    expect(needsRaster(0x3299, 0, "")).toBe(true); // ㊙
  });

  it("rasters 〽 U+303D (text-default, cascade-gated) — DM-1173", () => {
    // PART ALTERNATION MARK: Emoji=Yes but text-default, so it's color only when
    // the cascade reaches Apple Color Emoji (many text fonts cover it). No-font
    // context → raster fail-safe; the monochrome outcome is covered by the
    // 3000-303F-cjk-symbols-and-punctuation visual fixture.
    expect(needsRaster(0x303D, 0, "")).toBe(true);
    expect(needsRaster(0x303C, 0, "x")).toBe(false); // 〼 just below — not emoji
    expect(needsRaster(0x303E, 0, "x")).toBe(false); // 〾 just above — not emoji
  });

  it("treats the U+2B?? emoji-presentation symbols as cascade-gated, not unconditional — DM-1165", () => {
    // ⬅⬆⬇ ⬛⬜ ⭐ ⭕ are color OR mono depending on the cascade (Apple Symbols /
    // STIX Two Math cover several as monochrome). With no font context the probe
    // short-circuits to the raster fail-safe; the monochrome-cascade outcome
    // (the 2B00 fixture leads with "Apple Symbols") is covered by the
    // 2B00-2BFF-miscellaneous-symbols-and-arrows visual fixture.
    for (const cp of [0x2B05, 0x2B06, 0x2B07, 0x2B1B, 0x2B1C, 0x2B50, 0x2B55]) {
      expect(needsRaster(cp, 0, "")).toBe(true);   // no-font fail-safe → raster
    }
    // A monochrome symbol-font context must NOT raster (would stamp emoji over
    // Chrome's text glyph). `isColorGlyph` needs a DOM, so this exact path is the
    // fixture's job; here we only assert the codepoints route THROUGH the probe
    // rather than the old unconditional `return true` — `0x2B04` (not emoji)
    // stays false as a control.
    expect(needsRaster(0x2B04, 0, "x")).toBe(false);
  });

  it("does NOT raster non-emoji symbols / arrows / enclosed letters", () => {
    expect(needsRaster(0x2701, 0, "x")).toBe(false); // ✁ scissors (path glyph)
    expect(needsRaster(0x2190, 0, "x")).toBe(false); // ← arrow
    expect(needsRaster(0x1F100, 0, "x")).toBe(false); // 🄀 (mono, below squared range)
    expect(needsRaster(0x1F18F, 0, "x")).toBe(false); // gap just past 🆎
    expect(needsRaster(0x1F19B, 0, "x")).toBe(false); // just past 🆚
    expect(needsRaster(0x3298, 0, "x")).toBe(false); // 労 U+3298 — circled, but NOT emoji-presentation
    expect(needsRaster(0x3296, 0, "x")).toBe(false); // ㊖ just below ㊗
  });
});
