import { describe, expect, it } from "vitest";
import { alignLineGlyphs, type AlignGlyph } from "./glyph-align.js";

// The frame-sequence compressor's per-line aligner (docs/100, Primitive 1).
// The binding design constraint from the measured evaluation: ORDER-PRESERVING
// alignment (LCS), never greedy/multiset matching — a greedy matcher measurably
// mispairs repeated characters. These tests pin the adversarial repeated-char
// cases, the mid-segment tail split, recolor pairing, and the re-emit-on-doubt
// drop rules.

const ADV = 7.53; // one Menlo-12.5px advance, the measured per-keystroke delta

/** Build a line: chars at x = start + i*adv (uniform advances). */
function line(text: string, opts: { start?: number; adv?: number; fill?: string | string[]; styleKey?: string } = {}): AlignGlyph[] {
  const { start = 100, adv = ADV, styleKey = "menlo|12.5" } = opts;
  return [...text].map((ch, i) => ({
    ch,
    x: start + i * adv,
    fill: Array.isArray(opts.fill) ? opts.fill[i] : (opts.fill ?? "#e2e8f0"),
    styleKey,
  }));
}

/** Map kept pairs as `prevIndex→nextIndex` for compact assertions. */
function pairMap(prev: AlignGlyph[], next: AlignGlyph[]): Map<number, number> {
  const { pairs } = alignLineGlyphs(prev, next);
  return new Map(pairs.map((p) => [p.prevIndex, p.nextIndex]));
}

describe("alignLineGlyphs — basic identity", () => {
  it("identical lines pair 1:1 exactly, nothing unpaired", () => {
    const a = line("const count = signal(0);");
    const r = alignLineGlyphs(a, line("const count = signal(0);"));
    expect(r.pairs).toHaveLength(a.length);
    expect(r.unpairedPrev).toEqual([]);
    expect(r.unpairedNext).toEqual([]);
    expect(r.pairs.every((p) => p.dx === 0 && !p.recolored)).toBe(true);
  });

  it("empty prev → all births; empty next → all deaths; both empty → nothing", () => {
    const a = line("abc");
    expect(alignLineGlyphs([], a)).toEqual({ pairs: [], unpairedPrev: [], unpairedNext: [0, 1, 2] });
    expect(alignLineGlyphs(a, [])).toEqual({ pairs: [], unpairedPrev: [0, 1, 2], unpairedNext: [] });
    expect(alignLineGlyphs([], [])).toEqual({ pairs: [], unpairedPrev: [], unpairedNext: [] });
  });

  it("completely different content pairs nothing (re-emit)", () => {
    const r = alignLineGlyphs(line("abc"), line("xyz"));
    expect(r.pairs).toEqual([]);
    expect(r.unpairedPrev).toEqual([0, 1, 2]);
    expect(r.unpairedNext).toEqual([0, 1, 2]);
  });

  it("a style-key change (bold-on-colorize) re-emits instead of pairing", () => {
    const r = alignLineGlyphs(line("word"), line("word", { styleKey: "menlo|12.5|bold" }));
    expect(r.pairs).toEqual([]);
    expect(r.unpairedPrev).toHaveLength(4);
    expect(r.unpairedNext).toHaveLength(4);
  });
});

describe("alignLineGlyphs — mid-line insert (the tail split)", () => {
  it("splits the tail exactly at the insertion point; tail rides one uniform dx", () => {
    // "import { signal, mount }" → one char of " computed," lands after "signal,":
    // "import { signal, mount }" with 'c' inserted at index 17.
    const prev = line("import { signal, mount }");
    const insertAt = 17;
    const nextText = "import { signal, cmount }";
    // Uniform monospace grid: the tail (old indices ≥ 17) sits one advance right.
    const next = line(nextText);
    const r = alignLineGlyphs(prev, next);
    // Every prev glyph survives; only the inserted 'c' is born.
    expect(r.unpairedPrev).toEqual([]);
    expect(r.unpairedNext).toEqual([insertAt]);
    const m = new Map(r.pairs.map((p) => [p.prevIndex, p]));
    for (let i = 0; i < prev.length; i++) {
      const p = m.get(i)!;
      if (i < insertAt) {
        expect(p.nextIndex).toBe(i);
        expect(p.dx).toBeCloseTo(0, 6); // prefix byte-stable
      } else {
        expect(p.nextIndex).toBe(i + 1);
        expect(p.dx).toBeCloseTo(ADV, 6); // tail = exactly one glyph advance
      }
    }
  });

  it("backspace: the deleted glyph dies and the tail shifts left uniformly", () => {
    const prev = line("hello!");
    // delete the 'l' at index 3 → "helo!" with tail moved left one advance
    const next = line("helo!");
    const r = alignLineGlyphs(prev, next);
    expect(r.unpairedNext).toEqual([]);
    // The exact-position bonus keeps the 'l' that did not move (prev index 2
    // pairs at its own x), so the SECOND 'l' is the one that dies.
    expect(r.unpairedPrev).toEqual([3]);
    for (const p of r.pairs) {
      if (p.prevIndex <= 2) expect(p.dx).toBeCloseTo(0, 6);
      else expect(p.dx).toBeCloseTo(-ADV, 6);
    }
  });
});

describe("alignLineGlyphs — adversarial repeated characters", () => {
  it("the ','/'e' mispair class: deleting a char before a repeated one never drags a comma through static text", () => {
    // prev: "e,e" — delete the first 'e' → ",e". A greedy exact-x matcher pairs
    // the ',' at its old x with the ',' now at x0 (a comma sliding left through
    // a static 'e'); order-preserving LCS instead reads it as: first 'e' dies,
    // ",e" tail shifts left one advance.
    const prev = line("e,e");
    const next = line(",e");
    const r = alignLineGlyphs(prev, next);
    expect(r.unpairedPrev).toEqual([0]);
    expect(r.unpairedNext).toEqual([]);
    const m = pairMap(prev, next);
    expect(m.get(1)).toBe(0); // ','
    expect(m.get(2)).toBe(1); // 'e'
    for (const p of r.pairs) expect(p.dx).toBeCloseTo(-ADV, 6);
  });

  it("typing a char identical to its neighbor stays monotonic (no cross-pairing)", () => {
    // "aab" → "aaab": the two prefix 'a's pair exactly at their own x; the
    // 1-char 'b' tail is a lone shifting glyph, so the singleton drop rule
    // re-emits it (death + birth) rather than risk a mispair.
    const prev = line("aab");
    const next = line("aaab");
    const r = alignLineGlyphs(prev, next);
    expect(r.pairs.map((p) => [p.prevIndex, p.nextIndex])).toEqual([[0, 0], [1, 1]]);
    expect(r.pairs.every((p) => p.dx === 0)).toBe(true);
    expect(r.unpairedPrev).toEqual([2]);
    expect(r.unpairedNext.sort((a, b) => a - b)).toEqual([2, 3]);
  });

  it("repeated commas across a line pair positionally, not by first-match", () => {
    // "a, b, c" with ' x' inserted after the FIRST comma → "a, x b, c".
    const prev = line("a, b, c");
    const next = line("a, x b, c");
    const r = alignLineGlyphs(prev, next);
    const m = new Map(r.pairs.map((p) => [p.prevIndex, p]));
    // Prefix "a, " exact; suffix "b, c" shifted by two advances.
    expect(m.get(1)!.dx).toBeCloseTo(0, 6); // first ','
    expect(m.get(4)!.dx).toBeCloseTo(2 * ADV, 6); // second ',' rides the tail
    expect(m.get(1)!.nextIndex).toBe(1);
    expect(m.get(4)!.nextIndex).toBe(6);
  });
});

describe("alignLineGlyphs — recolor (fill ignored for pairing)", () => {
  it("same char + position with a different fill pairs as a recolor, not a re-emit", () => {
    const prev = line("{ signal }", { fill: "#e2e8f0" });
    const next = line("{ signal }", { fill: [...("{ signal }")].map((ch) => (ch === "{" || ch === "}" ? "#fbbf24" : "#e2e8f0")) });
    const r = alignLineGlyphs(prev, next);
    expect(r.pairs).toHaveLength(prev.length);
    expect(r.unpairedPrev).toEqual([]);
    expect(r.unpairedNext).toEqual([]);
    const recolored = r.pairs.filter((p) => p.recolored);
    expect(recolored.map((p) => p.prevIndex)).toEqual([0, 9]);
    expect(r.pairs.every((p) => p.dx === 0)).toBe(true);
  });

  it("a recolor composes with a tail shift in the same transition", () => {
    // insert 'x' at 2 AND recolor the shifted trailing "cd" tail.
    const prev = line("abcd");
    const next: AlignGlyph[] = [
      { ch: "a", x: 100, fill: "#e2e8f0", styleKey: "menlo|12.5" },
      { ch: "b", x: 100 + ADV, fill: "#e2e8f0", styleKey: "menlo|12.5" },
      { ch: "x", x: 100 + 2 * ADV, fill: "#e2e8f0", styleKey: "menlo|12.5" },
      { ch: "c", x: 100 + 3 * ADV, fill: "#fbbf24", styleKey: "menlo|12.5" },
      { ch: "d", x: 100 + 4 * ADV, fill: "#e2e8f0", styleKey: "menlo|12.5" },
    ];
    const r = alignLineGlyphs(prev, next);
    const m = new Map(r.pairs.map((p) => [p.prevIndex, p]));
    expect(r.unpairedNext).toEqual([2]);
    expect(m.get(2)!.dx).toBeCloseTo(ADV, 6);
    expect(m.get(2)!.recolored).toBe(true);
    expect(m.get(3)!.dx).toBeCloseTo(ADV, 6);
    expect(m.get(3)!.recolored).toBe(false);
  });
});

describe("alignLineGlyphs — re-emit on doubt (drop rules)", () => {
  it("a lone glyph claiming a non-zero shift is demoted to death + birth", () => {
    // "ab)" → "abc)": the 1-char tail ')' would pair with dx=ADV, but a lone
    // shifting glyph is indistinguishable from a mispair — re-emit.
    const prev = line("ab)");
    const next = line("abc)");
    const r = alignLineGlyphs(prev, next);
    const m = pairMap(prev, next);
    expect(m.get(0)).toBe(0);
    expect(m.get(1)).toBe(1);
    expect(m.has(2)).toBe(false); // ')' re-emits
    expect(r.unpairedPrev).toEqual([2]);
    expect(r.unpairedNext.sort((a, b) => a - b)).toEqual([2, 3]);
  });

  it("a 2+ glyph tail with uniform dx IS kept (the drop rule only fires on singletons)", () => {
    const prev = line("ab);");
    const next = line("abc);");
    const r = alignLineGlyphs(prev, next);
    const m = new Map(r.pairs.map((p) => [p.prevIndex, p]));
    expect(m.get(2)!.dx).toBeCloseTo(ADV, 6);
    expect(m.get(3)!.dx).toBeCloseTo(ADV, 6);
    expect(r.unpairedNext).toEqual([2]);
  });

  it("non-uniform shifts inside one diagonal run split into sub-runs; lone outliers re-emit", () => {
    // Tail chars claim different deltas (kerning fallout): [+ADV, +ADV, +1.9].
    const prev = line("abcde", { fill: "#f", styleKey: "s" });
    const next: AlignGlyph[] = [
      { ch: "a", x: 100, fill: "#f", styleKey: "s" },
      { ch: "b", x: 100 + 1 * ADV, fill: "#f", styleKey: "s" },
      { ch: "c", x: 100 + 2 * ADV + ADV, fill: "#f", styleKey: "s" },
      { ch: "d", x: 100 + 3 * ADV + ADV, fill: "#f", styleKey: "s" },
      { ch: "e", x: 100 + 4 * ADV + 1.9, fill: "#f", styleKey: "s" },
    ];
    const r = alignLineGlyphs(prev, next);
    const m = new Map(r.pairs.map((p) => [p.prevIndex, p]));
    expect(m.get(0)!.dx).toBeCloseTo(0, 6);
    expect(m.get(1)!.dx).toBeCloseTo(0, 6);
    expect(m.get(2)!.dx).toBeCloseTo(ADV, 6); // uniform pair-run kept
    expect(m.get(3)!.dx).toBeCloseTo(ADV, 6);
    expect(m.has(4)).toBe(false); // lone 1.9px outlier → re-emit
    expect(r.unpairedPrev).toEqual([4]);
    expect(r.unpairedNext).toEqual([4]);
  });
});
