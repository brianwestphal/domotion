/**
 * Coverage is a CMAP question, not an outline question (DM-1986).
 *
 * `glyphIdForCp(font, cp) !== 0` was standing in for "does this font cover the
 * codepoint", and the two come apart on a bitmap-only colour font: fontkit maps
 * the character but cannot construct a Glyph, so the id test answers "not
 * covered" for the one font on the system that does cover it.
 *
 * Measured on Linux, `NotoColorEmoji.ttf` (CBDT/CBLC, no `glyf`, no `CFF`):
 *
 *     characterSet includes U+1F600      true
 *     hasGlyphForCodePoint(U+1F600)      true
 *     glyphForCodePoint(U+1F600)         null (no Glyph object)
 *     layout("😀")                        throws
 *
 * Consequence, before the fix: every emoji-presentation codepoint on Linux fell
 * through to the primary font. Chrome paints Noto Color Emoji; we painted
 * Liberation Sans. The `font-variant-emoji` probe went from 20/39 agreeing with
 * Chrome to 37/39 on the same host once coverage asked the cmap.
 *
 * Blink asks the cmap too — `FontContainsCharacter` and the fallback iterator's
 * has-a-glyph test both consult the character map rather than the outline
 * tables.
 */
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fontCoversCp, glyphIdForCp, type FontInstance } from "./font-resolution.js";

/** The two answers a font instance can give, independently controllable. */
const stub = (o: { hasGlyph?: boolean | (() => never); glyphId?: number | null }): FontInstance =>
  ({
    hasGlyphForCodePoint: o.hasGlyph == null ? undefined
      : typeof o.hasGlyph === "function" ? o.hasGlyph : () => o.hasGlyph as boolean,
    glyphForCodePoint: () => (o.glyphId == null ? null : { id: o.glyphId }),
  }) as unknown as FontInstance;

describe("fontCoversCp asks the cmap, not the outline tables (DM-1986)", () => {
  it("covers a codepoint the cmap maps but no Glyph can be built for", () => {
    // The bitmap-colour-font shape, which is the whole reason this exists.
    const bitmapColour = stub({ hasGlyph: true, glyphId: null });
    expect(glyphIdForCp(bitmapColour, 0x1f600), "precondition: the id test says uncovered").toBe(0);
    expect(fontCoversCp(bitmapColour, 0x1f600)).toBe(true);
  });

  it("does NOT cover a codepoint neither answer maps", () => {
    // Without this the fix would be "always true", which would route every
    // codepoint to whatever font was asked about first.
    expect(fontCoversCp(stub({ hasGlyph: false, glyphId: null }), 0x1f600)).toBe(false);
  });

  it("falls back to the id test when the instance has no cmap accessor", () => {
    // The native-helper instances (CoreText / DirectWrite) expose no
    // `hasGlyphForCodePoint`, so they must keep their existing behaviour
    // exactly — in BOTH directions.
    expect(fontCoversCp(stub({ glyphId: 42 }), 0x41)).toBe(true);
    expect(fontCoversCp(stub({ glyphId: null }), 0x41)).toBe(false);
  });

  it("falls back to the id test when the cmap accessor throws", () => {
    const throws = stub({ hasGlyph: () => { throw new Error("bad table"); }, glyphId: 42 });
    expect(fontCoversCp(throws, 0x41)).toBe(true);
  });

  it("treats a non-true return as no answer rather than as coverage", () => {
    // A fontkit version returning undefined must not read as "covered".
    const undef = { hasGlyphForCodePoint: () => undefined, glyphForCodePoint: () => null } as unknown as FontInstance;
    expect(fontCoversCp(undef, 0x1f600)).toBe(false);
  });
});

/**
 * The real font, on the platform that has it. Skips elsewhere rather than
 * asserting nothing — and the first expectation is the PRECONDITION that the
 * divergence is still real on this host, so a fontkit that learns to build
 * glyphs for CBDT faces turns this into a visible skip rather than a silent
 * pass.
 */
const NOTO_COLOR_EMOJI = "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf";
const describeLinuxEmoji = process.platform === "linux" && existsSync(NOTO_COLOR_EMOJI)
  ? describe : describe.skip;

describeLinuxEmoji("the real bitmap colour font (Linux)", () => {
  it("maps U+1F600 in its cmap while yielding no Glyph object", async () => {
    const fontkit = await import("fontkit");
    const f = (fontkit as unknown as { openSync(p: string): FontInstance })
      .openSync(NOTO_COLOR_EMOJI);
    expect(f.hasGlyphForCodePoint?.(0x1f600), "the cmap must map it").toBe(true);
    // Stated through `glyphIdForCp` rather than through the raw return, because
    // this IS the test the production code was making. (The raw return is
    // `null`, not `undefined` — asserting the exact falsy value pins a fontkit
    // implementation detail instead of the behaviour that matters.)
    expect(glyphIdForCp(f, 0x1f600), "and no Glyph must be constructible").toBe(0);
    expect(fontCoversCp(f, 0x1f600)).toBe(true);
  });
});
