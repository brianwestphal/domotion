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

  it("a vertically-moved line pairs across the move and rides a translateY (cross-line identity)", () => {
    const plan = buildCompressedRunPlan([
      state([box([lineEl("hello", { y: 100 })])]),
      state([box([lineEl("hello", { y: 119 })])]),
    ]);
    // The whole line pairs across the +19 move: no death, no birth.
    expect(plan.thread.deaths).toBe(0);
    expect(plan.thread.births).toBe(0);
    expect(plan.thread.paired).toBe(5);
    // Every glyph's y timeline records the move; x is unchanged.
    const h = ident(plan, "h")[0];
    expect(h.ys).toEqual([100, 119]);
    expect(h.xs[1] - h.xs[0]).toBeCloseTo(0, 6);
    // One group carries the whole moved line.
    expect(plan.groups.length).toBe(1);
  });
});

describe("buildCompressedRunPlan — cross-line identity (vertical line moves)", () => {
  it("insertLine: a new top line births and pushes N lines down, each paired via one uniform delta", () => {
    const three = (a: string, b: string, c: string, ys: [number, number, number]) =>
      [box([lineEl(a, { y: ys[0] }), lineEl(b, { y: ys[1] }), lineEl(c, { y: ys[2] })])];
    const plan = buildCompressedRunPlan([
      state(three("alpha;", "beta;", "gamma;", [100, 119, 138])),
      // A new line inserted at top pushes all three down by +19.
      state([box([
        lineEl("NEW();", { y: 100 }),
        lineEl("alpha;", { y: 119 }),
        lineEl("beta;", { y: 138 }),
        lineEl("gamma;", { y: 157 }),
      ])]),
    ]);
    // The three existing lines pair across the +19 move (no deaths); only the
    // new line's glyphs are born.
    expect(plan.thread.deaths).toBe(0);
    expect(plan.thread.births).toBe("NEW();".length);
    const a = ident(plan, "a").find((t) => t.rec.ch === "a" && t.ys[0] === 100)!;
    expect(a.ys).toEqual([100, 119]);
    const g = ident(plan, "g")[0];
    expect(g.ys).toEqual([138, 157]);
  });

  it("two identical lines swapping positions do NOT invent a cross-line move (order-preserving)", () => {
    // Both y's hold the same content in both states, so both are same-key
    // matches — no leftover buckets, no spurious translateY, no death/birth.
    const two = () => [box([lineEl("same;", { y: 100 }), lineEl("same;", { y: 119 })])];
    const plan = buildCompressedRunPlan([state(two()), state(two())]);
    expect(plan.thread.deaths).toBe(0);
    expect(plan.thread.births).toBe(0);
    for (const t of plan.thread.all) {
      expect(t.ys[0]).toBe(t.ys[t.ys.length - 1]); // no y move
    }
  });

  it("a line that moves AND is edited in the same state pairs via the block's shared delta", () => {
    const plan = buildCompressedRunPlan([
      state([box([lineEl("keep;", { y: 100 }), lineEl("edit;", { y: 119 }), lineEl("tail;", { y: 138 })])]),
      // Insert a top line: keep/edit/tail all shift +19, and `edit;`→`edXit;`
      // (a char typed) in the SAME state. keep + tail establish delta +19; the
      // edited line rides it (LCS handles the inserted glyph).
      state([box([
        lineEl("TOP();", { y: 100 }),
        lineEl("keep;", { y: 119 }),
        lineEl("edXit;", { y: 138 }),
        lineEl("tail;", { y: 157 }),
      ])]),
    ]);
    // `keep;` and `tail;` pair exactly across +19; `edit;` pairs across +19 with
    // one born glyph ('X'). Only 'X' and the new TOP line are births; no deaths.
    expect(plan.thread.deaths).toBe(0);
    const X = ident(plan, "X");
    expect(X).toHaveLength(1);
    expect(X[0].birth).toBe(1);
    expect(X[0].rec.segY).toBe(138); // born on the moved line's new y
    const k = ident(plan, "k").find((t) => t.rec.ch === "k")!;
    expect(k.ys).toEqual([100, 119]); // moved, paired, not re-emitted
  });
});

describe("buildCompressedRunPlan — region discrimination (independent panes)", () => {
  // A scene commonly holds several independently-updating regions — an editor
  // pane and a preview pane, both changing on their own timing. Line buckets
  // key on a segment's y, so two panes at the SAME vertical position would
  // merge into one logical line and the pairing pass would see a line whose
  // content changes wholesale whenever either pane changes. These pin the
  // discriminator that keeps them apart. The rasterized two-pane fixture lives
  // in tests/two-pane-regions.e2e.test.ts.

  /** A clipping pane (overflow: hidden) at `x`, holding the given lines. */
  const pane = (x: number, lines: CapturedElement[]): CapturedElement =>
    box(lines, { x, y: 0, width: 450, height: 420, styles: styles({ overflowX: "hidden", overflowY: "hidden" }) });
  /** A NON-clipping column: a tall box beside a sibling column, no overflow. */
  const column = (x: number, lines: CapturedElement[]): CapturedElement =>
    box(lines, { x, y: 0, width: 450, height: 420, styles: styles({ lineHeight: "19px" }) });

  const leftLines = (typed: string) => [
    lineEl(`let x = ${typed}1;`, { x: 20, y: 100 }),
    lineEl("call(x);", { x: 20, y: 119 }),
  ];
  /** The preview column scrolled by `off` lines: content moves up one line. */
  const rightLines = (off: number) =>
    ["alpha row", "beta row", "gamma row", "delta row"]
      .slice(off, off + 3)
      .map((t, i) => lineEl(t, { x: 500, y: 100 + i * 19 }));

  it("side-by-side clipping panes at the same y do not share a line bucket", () => {
    const plan = buildCompressedRunPlan([
      state([pane(0, leftLines("")), pane(450, rightLines(0))]),
      // The LEFT pane is edited while the RIGHT pane scrolls by one line in the
      // very same state — the case a shared bucket cannot express.
      state([pane(0, leftLines("y")), pane(450, rightLines(1))]),
    ]);
    // Right pane: `beta row` / `gamma row` were already painted, one line down;
    // they pair across the -19 move rather than dying and re-birthing.
    const b = ident(plan, "b").find((t) => t.ys[0] === 119)!;
    expect(b.ys).toEqual([119, 100]);
    // Left pane: only the typed glyph is born, and it did NOT move vertically.
    const y = ident(plan, "y");
    expect(y).toHaveLength(1);
    expect(y[0].birth).toBe(1);
    expect(y[0].ys).toEqual([100]);
    // `alpha row` scrolled off the top; nothing else dies.
    expect(plan.thread.deaths).toBe("alpha row".length);
  });

  it("non-clipping side-by-side columns are regions too (taller than one line box)", () => {
    const plan = buildCompressedRunPlan([
      state([box([column(0, leftLines("")), column(450, rightLines(0))], { x: 0, y: 0, width: 900, height: 420 })]),
      state([box([column(0, leftLines("y")), column(450, rightLines(1))], { x: 0, y: 0, width: 900, height: 420 })]),
    ]);
    const b = ident(plan, "b").find((t) => t.ys[0] === 119)!;
    expect(b.ys).toEqual([119, 100]);
    expect(plan.thread.deaths).toBe("alpha row".length);
  });

  it("a one-line-tall cell beside its own line (a gutter) is NOT a region", () => {
    // The gutter number and its code line sit side by side and overlap
    // vertically exactly as two panes do — only their one-line height tells
    // them apart. They must stay ONE logical line, or every single-pane scene
    // would re-partition.
    const row = (n: string, code: string, y: number) =>
      box([lineEl(n, { x: 10, y, height: 19 }), lineEl(code, { x: 60, y, height: 19 })],
        { x: 0, y, width: 600, height: 19, styles: styles({ lineHeight: "19px" }) });
    const plan = buildCompressedRunPlan([
      state([box([row("1", "let x = 1;", 100), row("2", "call(x);", 119)])]),
      state([box([row("1", "let xy = 1;", 100), row("2", "call(x);", 119)])]),
    ]);
    const lineKeys = new Set(plan.thread.all.map((t) => t.rec.lineKey));
    expect(lineKeys.size).toBe(2); // one bucket per visual line, gutter included
    // ...and the row still behaves like a plain mid-line insert.
    expect(plan.thread.deaths).toBe(0);
    expect(plan.thread.births).toBe(1);
  });

  it("a single-region scene is byte-identical to one with no discriminator at all", () => {
    // The whole point of the coarse rule: a scene with one (or no) clipping
    // ancestor over all its text yields ONE region, so nothing about the
    // partition, the pairing, or the emitted bytes can move. Wrapping the very
    // same content in a clipping pane must therefore change nothing.
    const mk = (typed: string, wrap: boolean) => {
      const lines = [lineEl(`let x = ${typed}1;`, { x: 20, y: 100 }), lineEl("call(x);", { x: 20, y: 119 })];
      return wrap ? [pane(0, lines)] : [box(lines)];
    };
    const bare = composeCompressedRun([state(mk("", false)), state(mk("y", false))], { width: 900, height: 420, idPrefix: "cr" });
    const wrapped = composeCompressedRun([state(mk("", true)), state(mk("y", true))], { width: 900, height: 420, idPrefix: "cr" });
    expect(wrapped.pairingStats.glyphsPaired).toBe(bare.pairingStats.glyphsPaired);
    expect(wrapped.pairingStats.births).toBe(bare.pairingStats.births);
    expect(wrapped.pairingStats.deaths).toBe(bare.pairingStats.deaths);
    expect(wrapped.pairingStats.groupCount).toBe(bare.pairingStats.groupCount);
  });

  it("a region whose own box changes between states re-emits rather than mispairing", () => {
    // A pane that resized is a different region — re-emit on any doubt.
    const plan = buildCompressedRunPlan([
      state([pane(0, leftLines("")), pane(450, rightLines(0))]),
      state([
        pane(0, leftLines("")),
        box(rightLines(0), { x: 450, y: 0, width: 400, height: 420, styles: styles({ overflowX: "hidden", overflowY: "hidden" }) }),
      ]),
    ]);
    // The left pane is untouched; the resized right pane's glyphs all die and
    // re-birth (correct pixels, less compression).
    const right = "alpha rowbeta rowgamma row".length;
    expect(plan.thread.deaths).toBe(right);
    expect(plan.thread.births).toBe(right);
  });

  // ── Explicit region roots (the hybrid contract) ──────────────────────────
  // Auto-detection is the default; a caller that knows better stamps
  // `data-domotion-anim` on the region elements and passes those ids as
  // `regionRootIds`, which wins inside them and changes nothing outside.

  it("declared region roots separate panes the auto-detector would merge", () => {
    // Two side-by-side ONE-LINE-TALL cells: geometrically a gutter, so the
    // auto-detector deliberately keeps them in one bucket. Declaring them
    // splits them — which is exactly the case the override exists for.
    const cell = (x: number, id: string, lines: CapturedElement[]): CapturedElement =>
      box(lines, { x, y: 100, width: 300, height: 19, animId: id, styles: styles({ lineHeight: "19px" }) });
    const mk = (l: string, r: string) => [box([
      cell(0, "rgL", [lineEl(l, { x: 10, y: 100 })]),
      cell(300, "rgR", [lineEl(r, { x: 310, y: 100 })]),
    ], { x: 0, y: 100, width: 600, height: 19 })];

    const auto = buildCompressedRunPlan([state(mk("ab", "cd")), state(mk("ab", "cd"))]);
    expect(new Set(auto.thread.all.map((t) => t.rec.lineKey)).size).toBe(1);

    const declared = buildCompressedRunPlan([state(mk("ab", "cd")), state(mk("ab", "cd"))], "cr", ["rgL", "rgR"]);
    expect(new Set(declared.thread.all.map((t) => t.rec.region)).size).toBe(2);
    expect(new Set(declared.thread.all.map((t) => t.rec.lineKey)).size).toBe(2);
  });

  it("a DECLARED region survives its own box changing, where an auto-detected one re-emits", () => {
    // The auto-detector keys on geometry — all it has — so a resized pane is a
    // different region and its lines re-emit. A declared region is named by the
    // author, so it stays itself and its lines still pair. Bytes only: every
    // emitted position comes from that state's own capture.
    const paneEl = (w: number, lines: CapturedElement[], id?: string) =>
      box(lines, { x: 450, y: 0, width: w, height: 420, ...(id != null ? { animId: id } : {}),
        styles: styles({ overflowX: "hidden", overflowY: "hidden" }) });
    const mk = (w: number, id?: string) => [
      pane(0, leftLines("")),
      paneEl(w, rightLines(0), id),
    ];
    const right = "alpha rowbeta rowgamma row".length;

    const auto = buildCompressedRunPlan([state(mk(450)), state(mk(400))]);
    expect(auto.thread.deaths).toBe(right);

    const declared = buildCompressedRunPlan([state(mk(450, "rgR")), state(mk(400, "rgR"))], "cr", ["rgR"]);
    expect(declared.thread.deaths).toBe(0);
    expect(declared.thread.births).toBe(0);
  });

  it("auto-detection still subdivides INSIDE a declared region, and still runs outside it", () => {
    // The declaration is an override, not a replacement: a nested clipping
    // ancestor inside a declared region is still its own (finer) region, and
    // untouched siblings keep their auto-detected ones.
    const inner = (x: number, lines: CapturedElement[]) =>
      box(lines, { x, y: 0, width: 220, height: 420, styles: styles({ overflowX: "hidden", overflowY: "hidden" }) });
    const tree = [
      box([inner(0, [lineEl("aa", { x: 10, y: 100 })]), inner(220, [lineEl("bb", { x: 230, y: 100 })])],
        { x: 0, y: 0, width: 450, height: 420, animId: "rgL" }),
      pane(450, [lineEl("cc", { x: 460, y: 100 })]),
    ];
    const plan = buildCompressedRunPlan([state(tree), state(tree)], "cr", ["rgL"]);
    const regionOf = (ch: string) => plan.thread.all.find((t) => t.rec.ch === ch)!.rec.region;
    // Two nested clipping boxes inside the declared region → two regions, both
    // distinct from each other and from the undeclared sibling pane.
    expect(new Set([regionOf("a"), regionOf("b"), regionOf("c")]).size).toBe(3);
    // ...and the sibling pane's region is still the auto-detected geometry key.
    expect(regionOf("c").startsWith("R")).toBe(true);
  });

  it("passing no region roots is byte-identical to a build with no notion of them", () => {
    const mk = (typed: string) => [pane(0, leftLines(typed)), pane(450, rightLines(0))];
    const states = [state(mk("")), state(mk("y"))];
    const opts = { width: 900, height: 420, idPrefix: "cr" };
    const bare = composeCompressedRun(states, opts);
    const empty = composeCompressedRun(states, { ...opts, regionRootIds: [] });
    expect(empty.svg).toBe(bare.svg);
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
    // A→B→A REOPENS: the plain variant is emitted ONCE carrying two visibility
    // windows rather than a duplicate third variant.
    const root = plan.chromeRoots[0];
    expect(root.windows).toEqual([{ start: 0, end: 3 }]);
    const variants = root.children;
    expect(variants.length).toBe(2); // plain [0,1)+[2,3), highlighted [1,2)
    expect(variants.map((v) => v.windows)).toEqual([
      [{ start: 0, end: 1 }, { start: 2, end: 3 }],
      [{ start: 1, end: 2 }],
    ]);
  });

  it("chrome-variant reopen carries the whole subtree's window bookkeeping", () => {
    // A→B→A where the reappearing variant has DESCENDANTS: every node in the
    // reopened subtree must gain the new window, not just its root.
    const withKid = (bg?: string) => [box([
      box([lineEl("abc", { y: 100 })], { x: 40, y: 90, styles: styles(bg != null ? { backgroundColor: bg } : {}) }),
    ])];
    const plan = buildCompressedRunPlan([state(withKid()), state(withKid("rgb(59, 130, 246)")), state(withKid())]);
    const variants = plan.chromeRoots[0].children;
    expect(variants.length).toBe(2);
    const plain = variants[0];
    expect(plain.windows).toEqual([{ start: 0, end: 1 }, { start: 2, end: 3 }]);
    // ...and its descendant reopened in lockstep.
    expect(plain.children).toHaveLength(1);
    expect(plain.children[0].windows).toEqual([{ start: 0, end: 1 }, { start: 2, end: 3 }]);
  });

  it("a reopen never reorders paint: a variant that reappears out of position re-emits instead", () => {
    // The 'xxx' line reappears at state 2 with BYTE-IDENTICAL geometry (y=100,
    // so its captured record still deep-matches the inactive variant — the
    // reopen candidate genuinely exists) but now sits AFTER 'yyy' in document
    // order, while its inactive variant sits BEFORE 'yyy' in the union list.
    // Reopening in place would paint it under 'yyy' instead of over it, so the
    // position guard must refuse and fall back to a fresh variant.
    //
    // Geometry-preserving is the whole point of the fixture: an IN-FLOW row
    // that returns at a different sibling index also returns at a different
    // painted y, which makes its record unequal and kills the reopen candidate
    // before the position guard is ever consulted (pinned by the sibling test
    // below). Only out-of-flow-style, index-independent geometry reaches here.
    const L = (t: string, y: number) => lineEl(t, { y, styles: { backgroundColor: "rgb(1, 2, 3)" } });
    const plan = buildCompressedRunPlan([
      state([box([L("xxx", 100)])]),
      state([box([L("yyy", 120)])]),
      state([box([L("yyy", 120), L("xxx", 100)])]),
    ]);
    const variants = plan.chromeRoots[0].children;
    // Three emissions: the original 'xxx', 'yyy', and a FRESH 'xxx' variant —
    // the reopen was refused rather than reordering paint.
    expect(variants).toHaveLength(3);
    expect(variants.map((v) => [v.el.y, v.windows])).toEqual([
      [100, [{ start: 0, end: 1 }]],
      [120, [{ start: 1, end: 3 }]],
      [100, [{ start: 2, end: 3 }]],
    ]);
    // The invariant that actually matters: at EVERY state, the union's paint
    // order restricted to the nodes visible then equals that state's document
    // order. This is the direct "no observable reorder" proof — strictly
    // stronger than asserting the windows merely don't overlap.
    const geom = (el: { x: number; y: number; width: number; height: number }) => `${el.x},${el.y},${el.width},${el.height}`;
    const docOrder = [
      [[60, 100]],
      [[60, 120]],
      [[60, 120], [60, 100]],
    ];
    for (let s = 0; s < 3; s++) {
      const visible = variants.filter((v) => v.windows.some((w) => s >= w.start && s < w.end)).map((v) => geom(v.el));
      expect(visible, `state ${s}: union paint order must match document order`)
        .toEqual(docOrder[s].map(([x, y]) => `${x},${y},${3 * 7.5},19`));
    }
    // ...and the windows still partition the states (nothing visible twice).
    for (const v of variants) {
      for (let i = 1; i < v.windows.length; i++) {
        expect(v.windows[i].start).toBeGreaterThanOrEqual(v.windows[i - 1].end);
      }
    }
  });

  it("an in-flow row that returns at a different index is not a reopen candidate at all (its geometry moved)", () => {
    // Companion to the guard test: the reopen search matches on the captured
    // record, which carries ABSOLUTE geometry. An in-flow row that leaves and
    // returns below a newly inserted sibling returns at a different painted y,
    // so no byte-equal inactive variant exists and the position guard is never
    // consulted. Relaxing that guard could not recover this case; only a
    // geometry-independent identity could.
    const L = (t: string, y: number) => lineEl(t, { y, styles: { backgroundColor: "rgb(1, 2, 3)" } });
    const plan = buildCompressedRunPlan([
      state([box([L("alpha", 100), L("beta", 120)])]),
      state([box([L("alpha", 100)])]),
      state([box([L("alpha", 100), L("new", 120), L("beta", 140)])]),
    ]);
    // 'beta' comes back at y=140, not the y=120 its inactive variant holds — a
    // separate emission, with the old variant left closed. (Chrome-layer text
    // is stripped into the glyph layer, so variants are identified by the
    // captured box geometry rather than by text.)
    expect(plan.chromeRoots[0].children.map((v) => [v.el.y, v.el.width, v.windows])).toEqual([
      [100, 5 * 7.5, [{ start: 0, end: 3 }]],   // alpha, held throughout
      [120, 4 * 7.5, [{ start: 0, end: 1 }]],   // beta's original emission, closed for good
      [120, 3 * 7.5, [{ start: 2, end: 3 }]],   // the inserted 'new' row
      [140, 4 * 7.5, [{ start: 2, end: 3 }]],   // beta re-emitted at its NEW position
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

  it("a LATER negative-z-index box paints BELOW the text and does not demote it (real paint order)", () => {
    // v1 approximated "paints after" as DFS order plus "any non-auto z-index is
    // an occluder", so this overlay demoted the text even though a negative
    // z-index positioned child paints beneath its parent's in-flow content.
    // The real stacking/paint-order walk puts it before the text.
    const text = lineEl("abc", { x: 60, y: 100 });
    const under = box([], {
      x: 55, y: 95, width: 100, height: 30,
      styles: styles({ backgroundColor: "rgb(0, 0, 0)", position: "relative", zIndex: "-1" }),
    });
    const plan = buildCompressedRunPlan([state([box([text, under])])]);
    expect(glyphCount(plan)).toBe(3);
  });

  it("an EARLIER positive-z-index box still paints above the text and demotes it", () => {
    const over = box([], {
      x: 55, y: 95, width: 100, height: 30,
      styles: styles({ backgroundColor: "rgb(0, 0, 0)", position: "relative", zIndex: "5" }),
    });
    const text = lineEl("abc", { x: 60, y: 100 });
    const plan = buildCompressedRunPlan([state([box([over, text])])]);
    expect(glyphCount(plan)).toBe(0);
  });

  it("an occluder clipped away by its overflow ancestor does not demote the text", () => {
    // The overlay's box would intersect the text, but its scroller clips it to
    // a region that doesn't — the paint-order walk carries those clips.
    const text = lineEl("abc", { x: 60, y: 300 });
    const scroller = box([
      box([], { x: 55, y: 295, width: 100, height: 30, styles: styles({ backgroundColor: "rgb(0, 0, 0)" }) }),
    ], { x: 40, y: 80, width: 600, height: 100, styles: styles({ overflowX: "hidden", overflowY: "hidden" }) });
    const plan = buildCompressedRunPlan([state([box([text, scroller])])]);
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
    // Groups are anchored at their FINAL x and shift BACKWARD (DM-1762 rest =
    // identity), so the tail's step-end transform starts at translateX(-7.5px)
    // and resolves to translateX(0px) at the held final state.
    expect(res.svg).toMatch(/\{0%\{transform:translateX\(-7\.5px\)\}/);
    expect(res.svg).toMatch(/100%\{transform:translateX\(0px\)\}/);
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

  it("selection: off by default; opt-in emits docs/101 rects BEHIND the glyph layer", () => {
    const noSel = composeCompressedRun(seq(), { width: 640, height: 240, idPrefix: "s0" });
    expect(noSel.svg).not.toContain("tt-sel");

    // Select "let" (chars 0..3) on the import line, appearing at state 0.
    const withSel = composeCompressedRun(seq(), {
      width: 640, height: 240, idPrefix: "s1",
      selection: { target: { match: (el) => el.text === "let x = 1;" }, charStart: 0, charEnd: 3, color: "rgb(59, 130, 246)" },
    });
    expect(withSel.svg).toContain('class="text-track"');
    expect(withSel.svg).toContain('class="tt-sel"');
    expect(withSel.svg).toContain('fill="rgb(59, 130, 246)"');
    // z-order: the selection rect must precede the glyph layer's <text> — the
    // whole point of behind-glyph selection (chrome has no text; the eligible
    // line's glyphs are the only <text> in the run).
    expect(withSel.svg.indexOf("tt-sel")).toBeGreaterThan(0);
    expect(withSel.svg.indexOf("tt-sel")).toBeLessThan(withSel.svg.indexOf("<text"));
  });

  it("selection: a list of specs each resolve against their appear-state tree; clearState maps to a boundary", () => {
    const res = composeCompressedRun(seq(), {
      width: 640, height: 240, idPrefix: "s2",
      selection: [
        { target: { match: (el) => el.text === "let x = 1;" }, charStart: 0, charEnd: 3, state: 0, clearState: 1, sweepMs: 60 },
      ],
    });
    // Two selection stops on either side of the clear (grows then snaps to 0).
    expect(res.svg).toContain("tt-sel");
    // clearState 1 = 150ms of 1000ms = 15%; the rect snaps to the hidden width.
    expect(res.svg).toMatch(/15%\{width:0\.01px\}/);
  });

  it("selection: an unresolvable target is skipped (logged), not thrown", () => {
    const logs: string[] = [];
    const res = composeCompressedRun(seq(), {
      width: 640, height: 240, idPrefix: "s3", log: (m) => logs.push(m),
      selection: { target: { match: () => false }, charStart: 0, charEnd: 3 },
    });
    expect(res.svg).not.toContain("tt-sel");
    expect(logs.some((l) => /selection 0 .* did not resolve/.test(l))).toBe(true);
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
