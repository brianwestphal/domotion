import { describe, it, expect } from "vitest";
import { emojiSquareRect } from "./emoji.js";

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
