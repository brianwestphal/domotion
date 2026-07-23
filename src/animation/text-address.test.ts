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

// --- Mixed content: address a subtree as one logical string (DM-1756) ---
//
// Fixtures mirror the shapes a REAL capture produces (verified against
// Chromium via a Playwright probe): a parent's OWN text segments and its child
// elements' segments are captured SEPARATELY (the DOM interleave order between
// them is not preserved), so the addressing engine reconstructs reading order
// from painted geometry (baseline line-banding, then x within a line).

// <p>plain <b>bold</b> tail</p> — p owns "plain " (x 20..) and " tail" (x 92..)
// as two segments on one baseline; the child <b> owns "bold" (x 58..) BETWEEN
// them in visual x. The engine must interleave them into "plain bold tail".
function mixedInlineTree(): CapturedElement[] {
  const b = el({
    tag: "b", fontAscent: 14, fontDescent: 4, height: 18,
    textSegments: [seg({ text: "bold", x: 58, y: 22, width: 34, height: 18, xOffsets: [58, 68, 78, 82] })],
  });
  return [el({
    tag: "p", animId: "para", fontAscent: 14, fontDescent: 4, height: 18,
    textSegments: [
      seg({ text: "plain ", x: 20, y: 22, width: 38, height: 18, xOffsets: [20, 29, 32, 41, 45, 54] }),
      seg({ text: " tail", x: 92, y: 22, width: 25, height: 18, xOffsets: [92, 96, 101, 110, 113] }),
    ],
    children: [b],
  })];
}

// A tokenized code line: <div>[<span>const</span>][ = ][<span>42</span>][;]
// The div owns " = " and ";" between the token spans; the spans own their
// tokens. All on one baseline, resolved as one string by x order.
function codeLineTree(): CapturedElement[] {
  const kw = el({
    tag: "span", fontAscent: 13, fontDescent: 4, height: 20,
    textSegments: [seg({ text: "const", x: 20, y: 64, width: 45, height: 20, xOffsets: [20, 29, 38, 47, 56] })],
  });
  const num = el({
    tag: "span", fontAscent: 13, fontDescent: 4, height: 20,
    textSegments: [seg({ text: "42", x: 110, y: 64, width: 18, height: 20, xOffsets: [110, 119] })],
  });
  return [el({
    tag: "div", animId: "code", fontAscent: 13, fontDescent: 4, height: 20,
    textSegments: [
      seg({ text: " = ", x: 74, y: 64, width: 27, height: 20, xOffsets: [74, 83, 92] }),
      seg({ text: ";", x: 128, y: 64, width: 9, height: 20, xOffsets: [128] }),
    ],
    children: [kw, num],
  })];
}

// Nested deeper: <p>a <span><em>x</em></span> b</p> — the <span> is an empty
// wrapper (no segments, ascent 0); the addressable "x" lives on the <em> two
// levels down, between p's own "a " and " b".
function nestedDeepTree(): CapturedElement[] {
  const em = el({
    tag: "em", fontAscent: 14, fontDescent: 4, height: 18,
    textSegments: [seg({ text: "x", x: 33, y: 107, width: 8, height: 18, xOffsets: [33] })],
  });
  const span = el({ tag: "span", height: 0, children: [em] }); // empty wrapper
  return [el({
    tag: "p", animId: "nested", fontAscent: 14, fontDescent: 4, height: 18,
    textSegments: [
      seg({ text: "a ", x: 20, y: 107, width: 13, height: 18, xOffsets: [20, 29] }),
      seg({ text: " b", x: 41, y: 107, width: 13, height: 18, xOffsets: [41, 46] }),
    ],
    children: [span],
  })];
}

describe("mixed content — addressing across descendant elements (DM-1756)", () => {
  it("interleaves a parent's own text with a child element by painted x", () => {
    const roots = mixedInlineTree();
    // Logical string is "plain bold tail" — 15 code points.
    expect(addressableLength(roots, { animId: "para" })).toBe(15);
    // Offsets walk the three runs in reading order: p."plain " (0-5),
    // b."bold" (6-9), p." tail" (10-14), end (15).
    const xs = Array.from({ length: 16 }, (_, i) => resolveCaretPoint(roots, { animId: "para" }, i)?.x);
    expect(xs).toEqual([20, 29, 32, 41, 45, 54, 58, 68, 78, 82, 92, 96, 101, 110, 113, 117]);
    // The three runs carry their own captured baselines/heights — all on one
    // line here (y 22 + ascent 14 = baseline 36).
    expect(resolveCaretPoint(roots, { animId: "para" }, 7)?.baselineY).toBe(36);
  });

  it("offsets at child boundaries land on the adjacent run", () => {
    const roots = mixedInlineTree();
    // Offset 6 is the boundary between p."plain " and b."bold": it lands at the
    // START of "bold" (x 58), not after the space at p's run end.
    expect(resolveCaretPoint(roots, { animId: "para" }, 6)?.x).toBe(58);
    // Offset 10 is the boundary between b."bold" and p." tail": start of " tail".
    expect(resolveCaretPoint(roots, { animId: "para" }, 10)?.x).toBe(92);
  });

  it("end-of-subtree caret parks at the last run's captured right edge", () => {
    const p = resolveCaretPoint(mixedInlineTree(), { animId: "para" }, 15)!;
    expect(p.x).toBe(117); // " tail" x 92 + width 25
  });

  it("a range spanning children yields one correct rect per run", () => {
    // Select "in bold ta" — code points 3..12 (offsets 3-12): the tail of
    // "plain ", all of "bold", and the head of " tail".
    const r = resolveRangeRects(mixedInlineTree(), { animId: "para" }, 3, 13)!;
    expect(r.charCount).toBe(10);
    expect(r.rects).toHaveLength(3);
    // Run 1 (p."plain "): chars i, n, space → right edges 45, 54, 58.
    expect(r.rects[0].x).toBe(41);
    expect(r.rects[0].edges).toEqual([45, 54, 58]);
    // Run 2 (b."bold"): full word.
    expect(r.rects[1].x).toBe(58);
    expect(r.rects[1].edges).toEqual([68, 78, 82, 92]);
    // Run 3 (p." tail"): space, t, a.
    expect(r.rects[2].x).toBe(92);
    expect(r.rects[2].edges).toEqual([96, 101, 110]);
  });

  it("resolves a tokenized code line across its colored token spans", () => {
    const roots = codeLineTree();
    // "const" + " = " + "42" + ";" = 5+3+2+1 = 11 code points (the whitespace
    // between const and the next token is NOT captured as its own segment).
    expect(addressableLength(roots, { animId: "code" })).toBe(11);
    const xs = Array.from({ length: 12 }, (_, i) => resolveCaretPoint(roots, { animId: "code" }, i)?.x);
    // const(20,29,38,47,56) = (74,83,92) 42(110,119) ;(128) end(137).
    expect(xs).toEqual([20, 29, 38, 47, 56, 74, 83, 92, 110, 119, 128, 137]);
    // Addressing char 12 of the whole line (inside "42") resolves across the
    // spans by line-selector alone — the DM-1747 use case.
    expect(resolveCaretPoint(roots, { animId: "code" }, 9)?.x).toBe(119);
  });

  it("recurses through an empty wrapper into a deeply-nested run", () => {
    const roots = nestedDeepTree();
    // "a " + "x" + " b" = 5 code points; <em> two levels down supplies the x.
    expect(addressableLength(roots, { animId: "nested" })).toBe(5);
    const xs = Array.from({ length: 6 }, (_, i) => resolveCaretPoint(roots, { animId: "nested" }, i)?.x);
    expect(xs).toEqual([20, 29, 33, 41, 46, 54]); // end = " b" x 41 + width 13

  });

  it("descendant runs keep their own font metrics, not the target's", () => {
    // A superscript-like child on a shifted baseline stays on the same LINE
    // (small baseline delta) but resolves with its OWN ascent/fontSize.
    const sup = el({
      tag: "sup",
      styles: { fontSize: "10px", fontFamily: "Helvetica", fontWeight: "400" } as CapturedElement["styles"],
      fontAscent: 8, fontDescent: 2, height: 12,
      textSegments: [seg({ text: "2", x: 40, y: 98, width: 6, height: 12, xOffsets: [40] })],
    });
    const roots = [el({
      tag: "p", animId: "sup", fontAscent: 14, fontDescent: 4, height: 18,
      textSegments: [seg({ text: "x", x: 20, y: 100, width: 18, height: 18, xOffsets: [20] })],
      children: [sup],
    })];
    // base "x" baseline 100+14=114; sup "2" baseline 98+8=106 — within 0.6em of
    // the base, so ONE line, ordered x → "x" then "2".
    expect(addressableLength(roots, { animId: "sup" })).toBe(2);
    expect(resolveCaretPoint(roots, { animId: "sup" }, 0)?.x).toBe(20);
    const two = resolveCaretPoint(roots, { animId: "sup" }, 1)!;
    expect(two.x).toBe(40);
    expect(two.fontSize).toBe(10);   // the sup's own size, not the p's 16
    expect(two.ascentPx).toBe(8);    // the sup's own ascent
  });

  it("block-level descendants become separate lines top-to-bottom", () => {
    // Two <div> lines inside the target (each its own baseline a line apart):
    // addressed as one string, the second line's chars follow the first's.
    const line2 = el({
      tag: "div", fontAscent: 14, fontDescent: 4, height: 18,
      textSegments: [seg({ text: "yz", x: 20, y: 130, width: 18, height: 18, xOffsets: [20, 29] })],
    });
    const line1 = el({
      tag: "div", fontAscent: 14, fontDescent: 4, height: 18,
      textSegments: [seg({ text: "ab", x: 20, y: 100, width: 18, height: 18, xOffsets: [20, 29] })],
    });
    // Children deliberately out of DOM/visual order to prove geometry ordering.
    const roots = [el({ tag: "section", animId: "blk", children: [line2, line1] })];
    expect(addressableLength(roots, { animId: "blk" })).toBe(4);
    // Reading order is ab (y 100) then yz (y 130) despite child array order.
    expect(resolveCaretPoint(roots, { animId: "blk" }, 0)?.baselineY).toBe(114);
    expect(resolveCaretPoint(roots, { animId: "blk" }, 2)?.baselineY).toBe(144); // start of "yz"
    const rr = resolveRangeRects(roots, { animId: "blk" }, 0, 4)!;
    expect(rr.rects.map((r) => r.y)).toEqual([100, 130]);
  });

  it("preserves single-element output byte-for-byte (no descendant runs)", () => {
    // The legacy single-element / input-value paths must be UNCHANGED: these
    // are the same trees the core suite above asserts, re-checked here to pin
    // that the subtree generalization did not perturb them.
    expect(addressableLength(astralTree(), { animId: "t1" })).toBe(3);
    expect(resolveCaretPoint(astralTree(), { animId: "t1" }, 3)?.x).toBe(44);
    expect(resolveCaretPoint(twoLineTree(), { animId: "wrap" }, 2)?.baselineY).toBe(136);
    const input = [el({
      tag: "input", animId: "field", text: "hi", fontAscent: 11, fontDescent: 3,
      textLeft: 24, textTop: 40, textWidth: 18, inputXOffsets: [24, 32],
    })];
    expect(resolveCaretPoint(input, { animId: "field" }, 2)?.x).toBe(42);
  });
});
