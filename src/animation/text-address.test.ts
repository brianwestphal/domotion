import { describe, expect, it } from "vitest";
import type { CapturedElement, TextSegment } from "../capture/types.js";
import { addressableLength, findAddressedElement, resolveCaretPoint, resolveRangeRects } from "./text-address.js";

// Minimal CapturedElement factory (the magic-move.test.ts pattern): only the
// fields the addressing engine reads are populated; styles is a partial cast.
function el(opts: Partial<CapturedElement> & { tag: string }): CapturedElement {
  return {
    text: "",
    x: 0, y: 0, width: 100, height: 20,
    children: [],
    styles: { fontSize: "16px", fontFamily: "Helvetica, sans-serif", fontWeight: "400" } as CapturedElement["styles"],
    ...opts,
  } as CapturedElement;
}

function seg(opts: Partial<TextSegment> & { text: string; x: number; y: number }): TextSegment {
  return { width: 0, height: 18, ...opts } as TextSegment;
}

// One line "a😀b": 'a' at x=10, the astral 😀 (TWO UTF-16 units, ONE code
// point, both units at the same painted x per the capture convention) at 18,
// 'b' at 30; captured run width 34 → right edge 44.
function astralTree(): CapturedElement[] {
  return [el({
    tag: "div", animId: "t1", fontAscent: 12, fontDescent: 4,
    textSegments: [seg({ text: "a\u{1F600}b", x: 10, y: 100, width: 34, xOffsets: [10, 18, 18, 30] })],
  })];
}

// Two wrapped lines: "ab" then "cd" (a second segment on the next baseline).
function twoLineTree(): CapturedElement[] {
  return [el({
    tag: "p", animId: "wrap", fontAscent: 12, fontDescent: 4,
    textSegments: [
      seg({ text: "ab", x: 10, y: 100, width: 20, xOffsets: [10, 20] }),
      seg({ text: "cd", x: 10, y: 124, width: 22, xOffsets: [10, 21] }),
    ],
  })];
}

describe("findAddressedElement", () => {
  it("finds a nested element by animId (DFS, first match)", () => {
    const target = el({ tag: "span", animId: "deep" });
    const roots = [el({ tag: "body", children: [el({ tag: "div", children: [target] })] })];
    expect(findAddressedElement(roots, { animId: "deep" })).toBe(target);
    expect(findAddressedElement(roots, { animId: "nope" })).toBeNull();
  });

  it("supports a programmatic match predicate; animId wins when both given", () => {
    const a = el({ tag: "b", animId: "x" });
    const b = el({ tag: "i" });
    const roots = [el({ tag: "body", children: [a, b] })];
    expect(findAddressedElement(roots, { match: (e) => e.tag === "i" })).toBe(b);
    expect(findAddressedElement(roots, { animId: "x", match: (e) => e.tag === "i" })).toBe(a);
  });
});

describe("resolveCaretPoint — code-point indexing over captured xOffsets", () => {
  it("indexes by code point, not UTF-16 (astral pair = one position)", () => {
    const roots = astralTree();
    // offset 0 → 'a' left edge; 1 → 😀 (utf16 index 1); 2 → 'b' (utf16 index 3).
    expect(resolveCaretPoint(roots, { animId: "t1" }, 0)?.x).toBe(10);
    expect(resolveCaretPoint(roots, { animId: "t1" }, 1)?.x).toBe(18);
    expect(resolveCaretPoint(roots, { animId: "t1" }, 2)?.x).toBe(30);
  });

  it("offset == length parks the caret after the last char at the captured right edge", () => {
    const p = resolveCaretPoint(astralTree(), { animId: "t1" }, 3);
    expect(p?.x).toBe(44); // seg.x 10 + captured width 34
  });

  it("rejects out-of-range offsets and unresolvable targets", () => {
    expect(resolveCaretPoint(astralTree(), { animId: "t1" }, 4)).toBeNull();
    expect(resolveCaretPoint(astralTree(), { animId: "t1" }, -1)).toBeNull();
    expect(resolveCaretPoint(astralTree(), { animId: "zz" }, 0)).toBeNull();
  });

  it("derives baseline and caret box from the captured metrics", () => {
    const p = resolveCaretPoint(astralTree(), { animId: "t1" }, 0)!;
    expect(p.baselineY).toBe(112); // seg top 100 + fontAscent 12
    expect(p.ascentPx).toBe(12);
    expect(p.descentPx).toBe(4);
    expect(p.fontSize).toBe(16);
  });

  it("cell width = the addressed char's painted advance (astral-aware); space advance at end", () => {
    const roots = astralTree();
    expect(resolveCaretPoint(roots, { animId: "t1" }, 0)?.cellWidthPx).toBe(8);  // a: 18-10
    expect(resolveCaretPoint(roots, { animId: "t1" }, 1)?.cellWidthPx).toBe(12); // 😀: 30-18 (skips the pair's 2nd unit)
    expect(resolveCaretPoint(roots, { animId: "t1" }, 2)?.cellWidthPx).toBe(14); // b: right edge 44 - 30
    const end = resolveCaretPoint(roots, { animId: "t1" }, 3)!;
    expect(end.cellWidthPx).toBeGreaterThan(0); // space advance (font-dependent)
  });

  it("segment boundaries: an offset at a line break lands at the NEXT line's start", () => {
    const roots = twoLineTree();
    // Offsets 0/1 on line 1; offset 2 = start of line 2 (not after 'b').
    expect(resolveCaretPoint(roots, { animId: "wrap" }, 1)?.baselineY).toBe(112);
    const atBreak = resolveCaretPoint(roots, { animId: "wrap" }, 2)!;
    expect(atBreak.x).toBe(10);
    expect(atBreak.baselineY).toBe(136); // second segment top 124 + ascent 12
    // Offset 4 (== total) → after 'd' on line 2, at its captured right edge.
    const end = resolveCaretPoint(roots, { animId: "wrap" }, 4)!;
    expect(end.x).toBe(32); // 10 + width 22
    expect(end.baselineY).toBe(136);
  });

  it("falls back to advance-derived offsets when xOffsets are missing", () => {
    const roots = [el({
      tag: "div", animId: "nf", fontAscent: 12, fontDescent: 4,
      textSegments: [seg({ text: "abc", x: 50, y: 10 })], // no xOffsets, no width
    })];
    const p0 = resolveCaretPoint(roots, { animId: "nf" }, 0)!;
    const p1 = resolveCaretPoint(roots, { animId: "nf" }, 1)!;
    const p3 = resolveCaretPoint(roots, { animId: "nf" }, 3)!;
    expect(p0.x).toBe(50); // anchored at the run's captured x
    expect(p1.x).toBeGreaterThan(p0.x); // advances accumulate monotonically
    expect(p3.x).toBeGreaterThan(p1.x);
    expect(p0.cellWidthPx).toBeGreaterThan(0);
  });

  it("addresses a captured form field via the input-value synthesis", () => {
    const roots = [el({
      tag: "input", animId: "field", text: "hi", fontAscent: 11, fontDescent: 3,
      textLeft: 24, textTop: 40, textWidth: 18,
      inputXOffsets: [24, 32],
    })];
    const p = resolveCaretPoint(roots, { animId: "field" }, 1)!;
    expect(p.x).toBe(32);
    expect(p.baselineY).toBe(51); // textTop 40 + fontAscent 11
    expect(resolveCaretPoint(roots, { animId: "field" }, 2)?.x).toBe(42); // 24 + textWidth 18
  });

  it("returns null for an element with no addressable text", () => {
    const roots = [el({ tag: "div", animId: "empty" })];
    expect(resolveCaretPoint(roots, { animId: "empty" }, 0)).toBeNull();
    expect(addressableLength(roots, { animId: "empty" })).toBeNull();
  });
});

describe("addressableLength", () => {
  it("counts code points across segments (astral pair = 1)", () => {
    expect(addressableLength(astralTree(), { animId: "t1" })).toBe(3);
    expect(addressableLength(twoLineTree(), { animId: "wrap" })).toBe(4);
  });
});

describe("resolveRangeRects", () => {
  it("returns one rect with per-code-point sweep edges within a single segment", () => {
    const r = resolveRangeRects(astralTree(), { animId: "t1" }, 0, 3)!;
    expect(r.rects).toHaveLength(1);
    expect(r.charCount).toBe(3);
    const rect = r.rects[0];
    expect(rect.x).toBe(10);
    expect(rect.y).toBe(100); // font-box top = run top
    expect(rect.height).toBe(16); // ascent 12 + descent 4
    expect(rect.edges).toEqual([18, 30, 44]); // per CODE POINT, astral-aware
    expect(rect.width).toBe(34);
  });

  it("covers a sub-range starting mid-run", () => {
    const r = resolveRangeRects(astralTree(), { animId: "t1" }, 1, 3)!;
    expect(r.rects[0].x).toBe(18);
    expect(r.rects[0].edges).toEqual([30, 44]);
    expect(r.rects[0].width).toBe(26);
  });

  it("spans wrapped lines with one rect per segment", () => {
    const r = resolveRangeRects(twoLineTree(), { animId: "wrap" }, 1, 4)!;
    expect(r.rects).toHaveLength(2);
    expect(r.charCount).toBe(3);
    // Line 1: just 'b' (x 20 → right edge 30 = 10 + width 20).
    expect(r.rects[0].x).toBe(20);
    expect(r.rects[0].y).toBe(100);
    expect(r.rects[0].edges).toEqual([30]);
    // Line 2: 'c' and 'd'.
    expect(r.rects[1].x).toBe(10);
    expect(r.rects[1].y).toBe(124);
    expect(r.rects[1].edges).toEqual([21, 32]);
  });

  it("rejects empty / inverted / unresolvable ranges", () => {
    expect(resolveRangeRects(astralTree(), { animId: "t1" }, 2, 2)).toBeNull();
    expect(resolveRangeRects(astralTree(), { animId: "t1" }, 2, 1)).toBeNull();
    expect(resolveRangeRects(astralTree(), { animId: "t1" }, 5, 9)).toBeNull();
    expect(resolveRangeRects(astralTree(), { animId: "nope" }, 0, 1)).toBeNull();
  });
});
