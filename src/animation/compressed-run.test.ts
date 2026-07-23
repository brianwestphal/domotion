import { describe, expect, it } from "vitest";
import type { CapturedElement, CapturedStyles, TextSegment } from "../capture/types.js";
import { buildCompressedRunPlan, composeCompressedRun, type CompressedRunState } from "./compressed-run.js";

// Frame-sequence compressor v1 (docs/100, Primitive 1) — plan-level unit
// coverage over synthetic captured trees: identity threading (birth/death/
// shift/fill timelines), the chrome union, eligibility guards, edit points,
// and the composed markup/CSS. The rasterized pixel verification lives in
// tests/compressed-run.e2e.test.ts.

const ADV = 7.5;

// Full computed-style defaults so the synthetic trees render through the real
// `elementTreeToSvgInner` (the renderer reads most of these unconditionally) —
// same shape as `src/render/anim-opacity-channel.test.ts`.
const BASE_STYLES = {
  backgroundColor: "rgba(0, 0, 0, 0)", backgroundImage: "none", backgroundSize: "auto",
  backgroundPosition: "0% 0%", backgroundRepeat: "repeat", backgroundClip: "border-box",
  backgroundOrigin: "padding-box", backgroundAttachment: "scroll",
  borderColor: "rgb(0,0,0)", borderWidth: "0", borderRadius: "0",
  borderTopLeftRadius: "0", borderTopRightRadius: "0", borderBottomRightRadius: "0", borderBottomLeftRadius: "0",
  borderTopWidth: "0", borderRightWidth: "0", borderBottomWidth: "0", borderLeftWidth: "0",
  borderTopColor: "rgb(0,0,0)", borderRightColor: "rgb(0,0,0)", borderBottomColor: "rgb(0,0,0)", borderLeftColor: "rgb(0,0,0)",
  borderTopStyle: "none", borderRightStyle: "none", borderBottomStyle: "none", borderLeftStyle: "none",
  color: "rgb(226, 232, 240)", fontSize: "12.5px", fontFamily: "Menlo, monospace", fontWeight: "400", fontStyle: "normal",
  lineHeight: "19px", letterSpacing: "normal", textAlign: "left", textTransform: "none",
  textDecoration: "none", textDecorationLine: "none", textDecorationStyle: "solid", textDecorationColor: "rgb(0,0,0)",
  textDecorationThickness: "auto", textUnderlineOffset: "auto", whiteSpace: "pre", wordSpacing: "0",
  verticalAlign: "baseline", direction: "ltr", writingMode: "horizontal-tb", textOverflow: "clip",
  cursor: "auto", caretColor: "auto", outlineColor: "rgb(0,0,0)", outlineWidth: "0", outlineStyle: "none", outlineOffset: "0",
  boxShadow: "none", opacity: "1", transform: "none", transformOrigin: "50% 50%", visibility: "visible",
  borderCollapse: "separate", overflowX: "visible", overflowY: "visible", scrollbarGutter: "auto",
  scrollWidth: 60, scrollHeight: 60, clientWidth: 60, clientHeight: 60, scrollTop: 0, scrollLeft: 0,
  objectFit: "fill", objectPosition: "50% 50%", filter: "none", backdropFilter: "none", mixBlendMode: "normal",
  clipPath: "none", mask: "none", maskImage: "none", maskMode: "match-source", maskSize: "auto",
  maskPosition: "0% 0%", maskRepeat: "repeat", maskComposite: "add",
  listStyleType: "none", listStyleImage: "none", display: "block", listStylePosition: "outside",
  paddingTop: "0", paddingRight: "0", paddingBottom: "0", paddingLeft: "0",
  borderImageSource: "none", borderImageSlice: "100%", borderImageWidth: "1", borderImageOutset: "0", borderImageRepeat: "stretch",
  zIndex: "auto", position: "static", float: "none", order: "0", flexDirection: "row",
  fontKerning: "auto", fontStretch: "100%", fontVariationSettings: "normal", fontFeatureSettings: "normal",
} as unknown as CapturedStyles;

function styles(over: Partial<CapturedStyles> = {}): CapturedStyles {
  return { ...BASE_STYLES, ...over } as CapturedStyles;
}

interface SegSpec {
  text: string;
  color?: string;
}

/** A text element whose segments lay out consecutively on a uniform advance
 *  grid starting at `x` (per-char captured xOffsets included). */
function lineEl(segs: SegSpec[] | string, opts: {
  x?: number; y?: number; styles?: Partial<CapturedStyles>; height?: number;
} = {}): CapturedElement {
  const specs: SegSpec[] = typeof segs === "string" ? [{ text: segs }] : segs;
  const x0 = opts.x ?? 60;
  const y = opts.y ?? 100;
  const height = opts.height ?? 19;
  const textSegments: TextSegment[] = [];
  let idx = 0;
  for (const sp of specs) {
    const xOffsets = [...sp.text].map((_, i) => x0 + (idx + i) * ADV);
    textSegments.push({
      text: sp.text,
      x: x0 + idx * ADV,
      y,
      width: sp.text.length * ADV,
      height,
      xOffsets,
      ...(sp.color != null ? { color: sp.color } : {}),
    });
    idx += sp.text.length;
  }
  const fullText = specs.map((s) => s.text).join("");
  return {
    tag: "div",
    text: fullText,
    x: x0,
    y,
    width: fullText.length * ADV,
    height,
    children: [],
    styles: styles(opts.styles),
    fontAscent: 11.5,
    fontDescent: 3,
    textSegments,
  } as CapturedElement;
}

function box(children: CapturedElement[], over: Partial<CapturedElement> = {}): CapturedElement {
  return {
    tag: "div",
    text: "",
    x: 40,
    y: 80,
    width: 600,
    height: 200,
    children,
    styles: styles({ backgroundColor: "rgb(30, 41, 59)" }),
    ...over,
  } as CapturedElement;
}

const state = (tree: CapturedElement[], holdMs = 100): CompressedRunState => ({ tree, holdMs });

/** Find the threaded identity of a glyph by char (+ optional birth). */
function ident(plan: ReturnType<typeof buildCompressedRunPlan>, ch: string, birth?: number) {
  return plan.thread.all.filter((t) => t.rec.ch === ch && (birth == null || t.birth === birth));
}

describe("buildCompressedRunPlan — identity threading", () => {
  it("identical adjacent states pair everything: no births, no deaths, no chrome tracks", () => {
    const mk = () => [box([lineEl("const x = 1;")])];
    const plan = buildCompressedRunPlan([state(mk()), state(mk()), state(mk())]);
    expect(plan.thread.births).toBe(0);
    expect(plan.thread.deaths).toBe(0);
    expect(plan.thread.paired).toBe(plan.thread.totalNext);
    expect(plan.edits).toEqual([]);
    // Every glyph identity spans the whole run; a single group, no windows.
    for (const t of plan.thread.all) {
      expect(t.birth).toBe(0);
      expect(t.death).toBe(3);
    }
    expect(plan.groups.length).toBe(1);
  });

  it("a mid-line insert births the typed glyph and shifts the tail by exactly one advance", () => {
    // "let x = 1;" → type 'y' after 'x' (index 5) → "let xy = 1;"
    const s0 = [box([lineEl("let x = 1;")])];
    const s1 = [box([lineEl("let xy = 1;")])];
    const plan = buildCompressedRunPlan([state(s0), state(s1)]);
    const y = ident(plan, "y");
    expect(y).toHaveLength(1);
    expect(y[0].birth).toBe(1);
    expect(y[0].death).toBe(2);
    // The tail "= 1;" glyphs shifted +ADV; the prefix stayed put.
    const eq = ident(plan, "=")[0];
    expect(eq.xs).toHaveLength(2);
    expect(eq.xs[1] - eq.xs[0]).toBeCloseTo(ADV, 6);
    const l = ident(plan, "l")[0];
    expect(l.xs[1] - l.xs[0]).toBeCloseTo(0, 6);
    // Edit point: after the typed glyph.
    expect(plan.edits).toHaveLength(1);
    expect(plan.edits[0].state).toBe(1);
    expect(plan.edits[0].x).toBeCloseTo(y[0].xs[0] + ADV, 6);
  });

  it("mid-segment tail split is exact: the tail group's xOffsets are the birth-state captures", () => {
    const s0 = [box([lineEl("let x = 1;")])];
    const s1 = [box([lineEl("let xy = 1;")])];
    const plan = buildCompressedRunPlan([state(s0), state(s1)]);
    // Tail group = glyphs alive [0,2) with dx timeline "0,+7.5".
    const tail = plan.groups.find((g) => g.glyphs.some((t) => t.rec.ch === "="))!;
    expect(tail).toBeDefined();
    const el = tail.glyphs[0];
    expect(el.xs[0]).toBeCloseTo(60 + 6 * ADV, 6); // '=' captured at its state-0 x
    // All tail glyphs share the same uniform shift timeline.
    for (const t of tail.glyphs) {
      expect(t.xs[1] - t.xs[0]).toBeCloseTo(ADV, 6);
    }
  });

  it("a recolor pairs in place as a fill step — no births, no motion", () => {
    // colorize-on-completion: same glyph geometry, new segment structure + colors.
    const s0 = [box([lineEl("let x = 1;")])];
    const s1 = [box([lineEl([{ text: "let", color: "rgb(147, 197, 253)" }, { text: " x = 1;" }])])];
    const plan = buildCompressedRunPlan([state(s0), state(s1)]);
    expect(plan.thread.births).toBe(0);
    expect(plan.thread.deaths).toBe(0);
    expect(plan.thread.recolored).toBe(3); // 'l' 'e' 't'
    const l = ident(plan, "l")[0];
    expect(l.fills).toEqual(["rgb(226, 232, 240)", "rgb(147, 197, 253)"]);
    expect(l.xs[1] - l.xs[0]).toBe(0);
    // Recolored glyphs coalesce into their own group (distinct fill timeline).
    const recoloredGroup = plan.groups.find((g) => g.glyphs.some((t) => t.rec.ch === "l"))!;
    expect(recoloredGroup.glyphs.map((t) => t.rec.ch).join("")).toBe("let");
    // No edit point for a pure recolor (nothing typed or deleted).
    expect(plan.edits).toEqual([]);
  });

  it("a re-tokenization state (recolors + whitespace churn) derives NO edit point — the caret holds", () => {
    // The flagship colorize-on-completion shape: every inked glyph pairs or
    // recolors in place while a SPACE re-segments across the new spans (its
    // style key changes with the segment structure, so it dies + re-births at
    // the same x). The auto-caret must NOT jump to the whitespace churn — a
    // real editor's caret stays put when the tokenizer catches up.
    const s0 = [box([lineEl([{ text: "let" }, { text: " x = 1;" }])])];
    const s1 = [box([lineEl([
      { text: "let", color: "rgb(147, 197, 253)" },
      { text: " ", color: "rgb(251, 191, 36)" }, // recolored space segment…
      { text: "x = 1;" },
    ])])];
    const plan = buildCompressedRunPlan([state(s0), state(s1)]);
    expect(plan.thread.recolored).toBeGreaterThan(0);
    expect(plan.edits).toEqual([]);
  });

  it("typing a space (no recolors) still derives an edit point after the typed space", () => {
    const s0 = [box([lineEl("abxy")])];
    const s1 = [box([lineEl("a bxy")])];
    const plan = buildCompressedRunPlan([state(s0), state(s1)]);
    expect(plan.edits).toHaveLength(1);
    // The space is born at index 1 (x0 + ADV); the caret lands after it.
    expect(plan.edits[0].x).toBeCloseTo(60 + 2 * ADV, 6);
  });

  it("backspace kills the glyph and closes the tail up; the edit point is the close-up x", () => {
    const s0 = [box([lineEl("let xy = 1;")])];
    const s1 = [box([lineEl("let x = 1;")])];
    const plan = buildCompressedRunPlan([state(s0), state(s1)]);
    const y = ident(plan, "y")[0];
    expect(y.birth).toBe(0);
    expect(y.death).toBe(1);
    const eq = ident(plan, "=")[0];
    expect(eq.xs[1] - eq.xs[0]).toBeCloseTo(-ADV, 6);
    expect(plan.edits).toHaveLength(1);
    expect(plan.edits[0].x).toBeCloseTo(y.xs[0], 6);
  });

  it("two edits on different lines in one run thread independently", () => {
    const mk = (l1: string, l2: string) => [box([lineEl(l1, { y: 100 }), lineEl(l2, { y: 119 })])];
    const plan = buildCompressedRunPlan([
      state(mk("aaa;", "zzz;")),
      state(mk("aaXa;", "zzz;")), // edit line 1
      state(mk("aaXa;", "zzYz;")), // edit line 2
    ]);
    const X = ident(plan, "X")[0];
    const Y = ident(plan, "Y")[0];
    expect(X.birth).toBe(1);
    expect(Y.birth).toBe(2);
    expect(X.rec.segY).toBe(100);
    expect(Y.rec.segY).toBe(119);
    // Line 2 was untouched at state 1 (its glyphs all paired exactly there).
    const z = ident(plan, "z");
    for (const t of z) expect(t.birth).toBe(0);
    expect(plan.edits.map((e) => e.state)).toEqual([1, 2]);
    expect(plan.edits[0].lineTop).toBe(100);
    expect(plan.edits[1].lineTop).toBe(119);
  });

  it("a vertically-moved line re-emits (no cross-line identity in v1)", () => {
    const plan = buildCompressedRunPlan([
      state([box([lineEl("hello", { y: 100 })])]),
      state([box([lineEl("hello", { y: 119 })])]),
    ]);
    // Different line buckets → all 5 die + 5 born.
    expect(plan.thread.deaths).toBe(5);
    expect(plan.thread.births).toBe(5);
  });
});

describe("buildCompressedRunPlan — chrome union", () => {
  it("static chrome is emitted once with no visibility windows", () => {
    const mk = () => [box([lineEl("abc")])];
    const plan = buildCompressedRunPlan([state(mk()), state(mk())]);
    // Root box window spans the whole run.
    expect(plan.chromeRoots).toHaveLength(1);
    expect(plan.chromeRoots[0].windows).toEqual([{ start: 0, end: 2 }]);
  });

  it("a box-paint change (select-ish highlight) re-emits that element as a windowed variant; text keeps pairing", () => {
    const mk = (bg?: string) => [box([lineEl("abc", { styles: bg != null ? { backgroundColor: bg } : {} })])];
    const plan = buildCompressedRunPlan([
      state(mk()),
      state(mk("rgb(59, 130, 246)")), // highlight appears behind the text
      state(mk()),
    ]);
    // Text pairs across all three states (positions unchanged).
    expect(plan.thread.births).toBe(0);
    expect(plan.thread.deaths).toBe(0);
    // The line element's chrome (its box paint) exists as windowed variants.
    const root = plan.chromeRoots[0];
    expect(root.windows).toEqual([{ start: 0, end: 3 }]);
    const variants = root.children;
    expect(variants.length).toBe(3); // plain [0,1), highlighted [1,2), plain [2,3)
    expect(variants.map((v) => v.windows)).toEqual([
      [{ start: 0, end: 1 }],
      [{ start: 1, end: 2 }],
      [{ start: 2, end: 3 }],
    ]);
  });

  it("chrome subtree replacement inserts the variant in paint order", () => {
    const a = () => lineEl("aaa", { y: 100 });
    const c = () => lineEl("ccc", { y: 140 });
    const plan = buildCompressedRunPlan([
      state([box([a(), c()])]),
      state([box([a(), lineEl("bbb", { y: 120, styles: { backgroundColor: "rgb(1, 2, 3)" } }), c()])]),
    ]);
    const kids = plan.chromeRoots[0].children;
    // a, (b inserted between), c — with b windowed to state 1 only.
    expect(kids).toHaveLength(3);
    expect(kids[1].windows).toEqual([{ start: 1, end: 2 }]);
    expect(kids[0].windows).toEqual([{ start: 0, end: 2 }]);
    expect(kids[2].windows).toEqual([{ start: 0, end: 2 }]);
  });
});

describe("buildCompressedRunPlan — eligibility guards (re-emit on doubt)", () => {
  const glyphCount = (plan: ReturnType<typeof buildCompressedRunPlan>) => plan.thread.all.length;

  it("complex-script text stays in the chrome layer", () => {
    const el = lineEl("مرحبا");
    const plan = buildCompressedRunPlan([state([box([el])]), state([box([el])])]);
    expect(glyphCount(plan)).toBe(0);
    // ...and the chrome union still carries the segments (flipbook fallback).
    const line = plan.chromeRoots[0].children[0];
    expect(line.el.textSegments).toBeDefined();
  });

  it("segments without captured xOffsets stay in the chrome layer", () => {
    const el = lineEl("abc");
    delete el.textSegments![0].xOffsets;
    const plan = buildCompressedRunPlan([state([box([el])])]);
    expect(glyphCount(plan)).toBe(0);
  });

  it("decorated text (underline) stays in the chrome layer", () => {
    const el = lineEl("abc", { styles: { textDecorationLine: "underline" } });
    const plan = buildCompressedRunPlan([state([box([el])])]);
    expect(glyphCount(plan)).toBe(0);
  });

  it("text under a transformed ancestor stays in the chrome layer", () => {
    const plan = buildCompressedRunPlan([
      state([box([lineEl("abc")], { styles: styles({ transform: "matrix(1, 0, 0, 1, 3, 0)" }) })]),
    ]);
    expect(glyphCount(plan)).toBe(0);
  });

  it("text occluded by a later box-painting element stays in the chrome layer", () => {
    const text = lineEl("abc", { x: 60, y: 100 });
    const overlay = box([], { x: 55, y: 95, width: 100, height: 30, styles: styles({ backgroundColor: "rgb(0, 0, 0)" }) });
    const plan = buildCompressedRunPlan([state([box([text, overlay])])]);
    expect(glyphCount(plan)).toBe(0);
  });

  it("a box painted BEFORE the text (an ancestor or underlay) does not demote it", () => {
    const underlay = box([], { x: 55, y: 95, width: 100, height: 30, styles: styles({ backgroundColor: "rgb(0, 0, 0)" }) });
    const text = lineEl("abc", { x: 60, y: 100 });
    const plan = buildCompressedRunPlan([state([box([underlay, text])])]);
    expect(glyphCount(plan)).toBe(3);
  });

  it("text outside an overflow-clipping ancestor stays in the chrome layer", () => {
    const clipped = box([lineEl("abc", { x: 60, y: 300 })], {
      x: 40, y: 80, width: 600, height: 100,
      styles: styles({ overflowX: "hidden", overflowY: "hidden" }),
    });
    const plan = buildCompressedRunPlan([state([clipped])]);
    expect(glyphCount(plan)).toBe(0);
  });
});

describe("buildCompressedRunPlan — transition matrix (type → colorize → select → backspace ×2)", () => {
  it("threads one realistic editing session's identities end to end", () => {
    const KW = "rgb(147, 197, 253)";
    const HL = "rgb(59, 130, 246)";
    const l2 = (t: string) => lineEl(t, { y: 119 });
    const seq: CompressedRunState[] = [
      state([box([lineEl("let x = 1;"), l2("done();")])]),                                        // s0
      state([box([lineEl("let xy = 1;"), l2("done();")])]),                                       // s1 type 'y'
      state([box([lineEl([{ text: "let", color: KW }, { text: " xy = 1;" }]), l2("done();")])]),  // s2 colorize
      state([box([lineEl([{ text: "let", color: KW }, { text: " xy = 1;" }], { styles: { backgroundColor: HL } }), l2("done();")])]), // s3 select-ish
      state([box([lineEl([{ text: "let", color: KW }, { text: " x = 1;" }]), l2("done();")])]),   // s4 backspace 'y'
      state([box([lineEl([{ text: "let", color: KW }, { text: " x = 1;" }]), l2("done()")])]),    // s5 backspace ';' on line 2
    ];
    const plan = buildCompressedRunPlan(seq);
    const N = 6;

    // 'y': born at 1, survives colorize + select (pairs in place), dies at 4.
    const y = ident(plan, "y");
    expect(y).toHaveLength(1);
    expect(y[0].birth).toBe(1);
    expect(y[0].death).toBe(4);

    // 'l' of "let": alive the whole run, recolored at s2, never moves.
    const l = ident(plan, "l", 0).find((t) => t.rec.segY === 100)!;
    expect(l.death).toBe(N);
    expect(l.fills).toEqual(["rgb(226, 232, 240)", "rgb(226, 232, 240)", KW, KW, KW, KW]);
    expect(new Set(l.xs).size).toBe(1);

    // '=': tail glyph — shifts +ADV at s1, holds through s2/s3, snaps back at s4.
    const eq = ident(plan, "=")[0];
    expect(eq.death).toBe(N);
    const dxs = eq.xs.map((x) => x - eq.xs[0]);
    expect(dxs[1]).toBeCloseTo(ADV, 6);
    expect(dxs[2]).toBeCloseTo(ADV, 6);
    expect(dxs[3]).toBeCloseTo(ADV, 6);
    expect(dxs[4]).toBeCloseTo(0, 6);
    expect(dxs[5]).toBeCloseTo(0, 6);

    // Line 2's ';' dies at s5; the rest of line 2 never changes.
    const semi2 = ident(plan, ";").find((t) => t.rec.segY === 119)!;
    expect(semi2.death).toBe(5);
    const d = ident(plan, "d").find((t) => t.rec.segY === 119)!;
    expect(d.birth).toBe(0);
    expect(d.death).toBe(N);

    // Edit points: type at 1, backspaces at 4 and 5 (colorize/select are not edits).
    expect(plan.edits.map((e) => e.state)).toEqual([1, 4, 5]);
    expect(plan.edits[2].lineTop).toBe(119);

    // The select-ish state re-emitted ONLY chrome (the highlight box), no glyphs.
    expect(plan.thread.births).toBe(1); // just 'y'
    expect(plan.thread.deaths).toBe(2); // 'y' + line-2 ';'
  });
});

describe("composeCompressedRun — composed output", () => {
  const seq = (): CompressedRunState[] => [
    state([box([lineEl("let x = 1;")])], 150),
    state([box([lineEl("let xy = 1;")])], 150),
    state([box([lineEl([{ text: "let", color: "rgb(147, 197, 253)" }, { text: " xy = 1;" }])])], 700),
  ];

  it("emits one self-contained SVG with step-end opacity/transform/fill tracks and stats", () => {
    const logs: string[] = [];
    const res = composeCompressedRun(seq(), { width: 640, height: 240, idPrefix: "t1", log: (m) => logs.push(m) });
    expect(res.durationMs).toBe(1000);
    expect(res.svg).toMatch(/^<svg /);
    expect(res.svg).toContain("step-end infinite");
    // Birth track (the typed 'y'), shift track (the tail), fill track (recolor).
    expect(res.svg).toMatch(/@keyframes t1k\d+\{0%\{opacity:0\}/);
    expect(res.svg).toMatch(/\{transform:translateX\(7\.5px\)\}/);
    expect(res.svg).toMatch(/@keyframes t1k\d+\{0%\{fill:rgb\(226, 232, 240\)\}/);
    // Groups carry anim classes; the fill track targets descendants.
    expect(res.svg).toMatch(/class="anim-t1g\d+"/);
    expect(res.svg).toMatch(/\.anim-t1g\d+ \*\{animation:/);
    // Stats + the one-line log.
    expect(res.pairingStats.states).toBe(3);
    expect(res.pairingStats.pairedPct).toBeGreaterThan(0.9);
    // (Real size reduction is asserted in the e2e on a realistic fixture; a
    // 10-character synthetic scene is dominated by per-track overhead.)
    expect(res.pairingStats.rawBytes).toBeGreaterThan(0);
    expect(res.pairingStats.compressedBytes).toBeGreaterThan(0);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^compress: run of 3 states, \d+\.\d% glyphs paired, [\d.]+ KB → [\d.]+ KB$/);
  });

  it("timeline boundaries land at the cumulative hold times", () => {
    const res = composeCompressedRun(seq(), { width: 640, height: 240, idPrefix: "t2" });
    // 150ms of 1000ms = 15%; 300ms = 30%.
    expect(res.svg).toContain("15%{");
    expect(res.svg).toContain("30%{");
  });

  it("does not mutate the input trees", () => {
    const states = seq();
    const before = JSON.stringify(states.map((s) => s.tree));
    composeCompressedRun(states, { width: 640, height: 240, idPrefix: "t3" });
    expect(JSON.stringify(states.map((s) => s.tree))).toBe(before);
  });

  it("caret: off by default; opt-in emits the docs/101 text-track group at the edit points", () => {
    const noCaret = composeCompressedRun(seq(), { width: 640, height: 240, idPrefix: "t4" });
    expect(noCaret.svg).not.toContain('class="text-track"');
    const withCaret = composeCompressedRun(seq(), { width: 640, height: 240, idPrefix: "t5", caret: true });
    expect(withCaret.svg).toContain('class="text-track"');
    expect(withCaret.edits).toHaveLength(1);
    expect(withCaret.edits[0].state).toBe(1);
  });

  it("a single-state run degenerates to a static frame (no tracks)", () => {
    const res = composeCompressedRun([state([box([lineEl("abc")])], 500)], { width: 640, height: 240, idPrefix: "t6" });
    expect(res.durationMs).toBe(500);
    expect(res.svg).not.toContain("@keyframes");
    expect(res.pairingStats.pairedPct).toBe(1);
  });

  it("manageFonts: false defers @font-face to the host pipeline", () => {
    const managed = composeCompressedRun(seq(), { width: 640, height: 240, idPrefix: "t7" });
    const deferred = composeCompressedRun(seq(), { width: 640, height: 240, idPrefix: "t8", manageFonts: false });
    expect(deferred.svg).not.toContain("@font-face");
    // (The managed run inlines whatever the host platform embeds — may be empty
    // on hosts without the font files, so only the deferred side is asserted.)
    expect(managed.svg).toMatch(/^<svg /);
  });

  it("background paints a root rect under the chrome", () => {
    const res = composeCompressedRun(seq(), { width: 640, height: 240, idPrefix: "t9", background: "rgb(232, 234, 238)" });
    expect(res.svg).toContain('<rect width="640" height="240" fill="rgb(232, 234, 238)"/>');
  });
});
