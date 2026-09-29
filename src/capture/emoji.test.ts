import { afterEach, describe, it, expect, vi } from "vitest";
import {
  __extractEmojiBitmapForTest,
  __setEmojiFontOpenerForTest,
  clearEmojiCaches,
  emojiSquareRect,
} from "./emoji.js";

// Chrome paints an Apple Color Emoji sbix glyph as a SQUARE whose side equals
// the glyph advance (the captured Range rect width, minus any letter-spacing
// Chrome appends to the right). `emojiSquareRect` is the pure geometry helper
// that snaps the captured per-char rect to that square; these tests lock in the
// behavior that DM-1198 (emojis painted ~20% too small) regressed.
describe("emojiSquareRect", () => {
  it("DM-1198: sizes the square to the ADVANCE, not the font size", () => {
    // At font-size 16 Chrome's emoji advance is 20px (a ~1.25× minimum). The
    // captured rect is 20 wide × 18 tall (line box). The square must be 20×20 —
    // the prior code snapped to fontSize (16×16), painting the emoji too small.
    const sq = emojiSquareRect({ x: 328.6, y: 243.6, width: 20, height: 18 }, 0);
    expect(sq.width).toBe(20);
    expect(sq.height).toBe(20);
  });

  it("anchors horizontally at the advance's left (rect.x), no centering shift", () => {
    const sq = emojiSquareRect({ x: 328.6, y: 243.6, width: 20, height: 18 }, 0);
    expect(sq.x).toBe(328.6);
  });

  it("vertically centers the square in the captured rect's line box", () => {
    // side 20 in a 18-tall rect → shift up by (18-20)/2 = -1.
    const sq = emojiSquareRect({ x: 0, y: 100, width: 20, height: 18 }, 0);
    expect(sq.y).toBe(99);
  });

  it("DM-438: a wider-than-tall rect extends to a square via the WIDTH", () => {
    // A 20×17 rect (smiley) becomes a 20×20 square extended upward.
    const sq = emojiSquareRect({ x: 10, y: 50, width: 20, height: 17 }, 0);
    expect(sq.width).toBe(20);
    expect(sq.height).toBe(20);
    expect(sq.y).toBe(50 + (17 - 20) / 2); // 48.5 — extended upward
  });

  it("DM-801/DM-919: subtracts letter-spacing from the advance width", () => {
    // font-size 48 with 8px letter-spacing captures a 56×63 rect (Chrome adds
    // the spacing to the right of the advance). Side = 56 − 8 = 48, and the
    // bitmap stays flush at rect.x (the spacing pads to the right).
    const sq = emojiSquareRect({ x: 100, y: 200, width: 56, height: 63 }, 8);
    expect(sq.width).toBe(48);
    expect(sq.height).toBe(48);
    expect(sq.x).toBe(100);
  });

  it("ignores negative letter-spacing (clamped to 0)", () => {
    const sq = emojiSquareRect({ x: 0, y: 0, width: 20, height: 18 }, -4);
    expect(sq.width).toBe(20);
  });

  it("never produces a non-positive side", () => {
    const sq = emojiSquareRect({ x: 0, y: 0, width: 5, height: 18 }, 10);
    expect(sq.width).toBeGreaterThanOrEqual(1);
    expect(sq.height).toBe(sq.width);
  });
});

describe("Apple Color Emoji font-load and bitmap-cache transitions", () => {
  const png = (n: number): { data: Buffer } => ({ data: Buffer.from([n, n, n]) });
  const glyph = (strikes: Record<number, { data: Buffer } | null>): unknown => ({
    id: 5,
    getImageForSize(ppem: number) {
      const hit = strikes[ppem];
      if (hit === undefined) throw new Error("no strike");
      return hit;
    },
  });
  const fontOf = (g: unknown): unknown => ({ glyphForCodePoint: () => g });

  afterEach(() => {
    __setEmojiFontOpenerForTest(null);
    clearEmojiCaches();
    vi.restoreAllMocks();
  });

  it("one failed open is retried and does not poison the bitmap cache", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let opens = 0;
    __setEmojiFontOpenerForTest(() => {
      if (++opens === 1) throw new Error("EMFILE");
      return fontOf(glyph({ 64: png(1) }));
    });
    expect(__extractEmojiBitmapForTest(0x1f600, 18)).toBeNull();
    const second = __extractEmojiBitmapForTest(0x1f600, 18);
    expect(second?.ppem).toBe(64);
    expect(opens).toBe(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it("gives up after three failed opens, warns once, and memoizes the absence", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let opens = 0;
    __setEmojiFontOpenerForTest(() => {
      opens++;
      throw new Error("broken");
    });
    for (let i = 0; i < 6; i++) expect(__extractEmojiBitmapForTest(0x1f600, 18)).toBeNull();
    expect(opens).toBe(3);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("clearEmojiCaches re-arms the open: absent font → clear → font present → bitmap", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    __setEmojiFontOpenerForTest(() => null);
    expect(__extractEmojiBitmapForTest(0x1f600, 18)).toBeNull();
    __setEmojiFontOpenerForTest(() => fontOf(glyph({ 64: png(2) })));
    // Still the memoized absence until cleared.
    expect(__extractEmojiBitmapForTest(0x1f600, 18)).toBeNull();
    clearEmojiCaches();
    expect(__extractEmojiBitmapForTest(0x1f600, 18)?.ppem).toBe(64);
  });

  it("an empty picked strike falls back to the largest populated one, memoized under the picked key", () => {
    let calls = 0;
    __setEmojiFontOpenerForTest(() => fontOf(glyph({ 64: { data: Buffer.alloc(0) }, 160: png(9) })));
    const first = __extractEmojiBitmapForTest(0x1f600, 18);
    expect(first?.ppem).toBe(160);
    __setEmojiFontOpenerForTest(() => {
      calls++;
      return null;
    });
    expect(__extractEmojiBitmapForTest(0x1f600, 18)).toBe(first);
    expect(calls).toBe(0);
  });

  it("a throwing glyph lookup warns once and is memoized, distinct from 'no bitmap'", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    __setEmojiFontOpenerForTest(() => ({
      glyphForCodePoint: () => {
        throw new Error("corrupt");
      },
    }));
    expect(__extractEmojiBitmapForTest(0x1f600, 18)).toBeNull();
    expect(__extractEmojiBitmapForTest(0x1f600, 18)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
