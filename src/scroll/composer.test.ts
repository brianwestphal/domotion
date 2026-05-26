import { describe, expect, it } from "vitest";

import type { CapturedElement } from "../capture/types.js";
import type { ScrollSegmentCapture } from "./executor.js";
import { composeScrollSvg } from "./composer.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a CapturedElement with a complete-enough `styles` object for the
 * renderer not to crash on undefined property lookups. ScrollPattern lifted from
 * `stacking-context.test.ts`'s `makeElement`.
 */
function el(opts: Partial<CapturedElement> & { tag: string; x: number; y: number }): CapturedElement {
  return {
    text: "",
    width: 100, height: 20,
    children: [],
    ...opts,
    styles: {
      backgroundColor: "rgba(0,0,0,0)",
      borderColor: "rgb(0,0,0)", borderWidth: "0", borderRadius: "0",
      borderTopLeftRadius: "0", borderTopRightRadius: "0", borderBottomRightRadius: "0", borderBottomLeftRadius: "0",
      borderTopWidth: "0", borderRightWidth: "0", borderBottomWidth: "0", borderLeftWidth: "0",
      borderTopColor: "rgb(0,0,0)", borderRightColor: "rgb(0,0,0)", borderBottomColor: "rgb(0,0,0)", borderLeftColor: "rgb(0,0,0)",
      borderTopStyle: "none", borderRightStyle: "none", borderBottomStyle: "none", borderLeftStyle: "none",
      color: "rgb(0,0,0)",
      fontSize: "16px", fontFamily: "sans-serif", fontWeight: "400", fontStyle: "normal",
      lineHeight: "20px", letterSpacing: "normal",
      textAlign: "left", textTransform: "none", textDecoration: "none",
      textDecorationLine: "none", textDecorationStyle: "solid",
      textDecorationColor: "rgb(0,0,0)", textDecorationThickness: "auto", textUnderlineOffset: "auto",
      whiteSpace: "normal", wordSpacing: "0", verticalAlign: "baseline",
      direction: "ltr", writingMode: "horizontal-tb", textOverflow: "clip",
      cursor: "auto", caretColor: "auto",
      outlineColor: "rgb(0,0,0)", outlineWidth: "0", outlineStyle: "none", outlineOffset: "0",
      boxShadow: "none",
      opacity: "1", transform: "none", transformOrigin: "50% 50%", visibility: "visible",
      borderCollapse: "separate",
      overflowX: "visible", overflowY: "visible", scrollbarGutter: "auto",
      scrollWidth: 100, scrollHeight: 100, clientWidth: 100, clientHeight: 100, scrollTop: 0, scrollLeft: 0,
      objectFit: "fill", objectPosition: "50% 50%",
      filter: "none", backdropFilter: "none", mixBlendMode: "normal",
      clipPath: "none", mask: "none", maskImage: "none", maskMode: "match-source",
      maskSize: "auto", maskPosition: "0% 0%", maskRepeat: "repeat", maskComposite: "add",
      listStyleType: "disc", listStyleImage: "none", display: "block", listStylePosition: "outside",
      backgroundImage: "none", backgroundSize: "auto", backgroundPosition: "0% 0%",
      backgroundRepeat: "repeat", backgroundClip: "border-box", backgroundOrigin: "padding-box", backgroundAttachment: "scroll",
      paddingTop: "0", paddingRight: "0", paddingBottom: "0", paddingLeft: "0",
      borderImageSource: "none", borderImageSlice: "100%", borderImageWidth: "1", borderImageOutset: "0", borderImageRepeat: "stretch",
      zIndex: "auto", position: "static", float: "none", order: "0", flexDirection: "row",
      ...(opts.styles ?? {}),
    } as CapturedElement["styles"],
  };
}

function makeSeg(scrollY: number, segStartMs: number, segEndMs: number, content?: CapturedElement[]): ScrollSegmentCapture {
  return {
    scrollX: 0, scrollY,
    segmentStartMs: segStartMs, segmentEndMs: segEndMs,
    tree: content ?? [el({ tag: "div", x: 0, y: 0 })],
    diffFromPrev: null,
  };
}

// ── Basic shape ─────────────────────────────────────────────────────────────

describe("composeScrollSvg: basic", () => {
  it("rejects an empty segment list", () => {
    expect(() => composeScrollSvg([], { viewportW: 800, viewportH: 600 })).toThrow();
  });

  it("single-segment input emits a static-ish SVG", () => {
    const svg = composeScrollSvg([makeSeg(0, 0, 0)], { viewportW: 800, viewportH: 600 });
    expect(svg).toMatch(/<svg [^>]*viewBox="0 0 800 600"/);
    expect(svg).toMatch(/<\?xml/);
  });

  it("multi-segment input includes a keyframes block", () => {
    const segs: ScrollSegmentCapture[] = [
      makeSeg(0,     0,    1000),
      makeSeg(600,   1000, 3000),
      makeSeg(1200,  3000, 5000),
    ];
    const svg = composeScrollSvg(segs, { viewportW: 800, viewportH: 600 });
    expect(svg).toMatch(/@keyframes/);
    // Three stops at 20% (1000/5000), 60% (3000/5000), 100%.
    expect(svg).toMatch(/20\.000% \{ transform: translate3d\(0, -/);
    expect(svg).toMatch(/60\.000% \{ transform: translate3d\(0, -/);
    expect(svg).toMatch(/100\.000% \{ transform: translate3d\(0, -/);
  });
});

// ── Composite dimensions ───────────────────────────────────────────────────

describe("composeScrollSvg: composite dimensions", () => {
  it("composite height = scroll-range + viewport-height for y-axis", () => {
    const segs: ScrollSegmentCapture[] = [
      makeSeg(0,    0, 1000),
      makeSeg(2400, 1000, 5000),
    ];
    const svg = composeScrollSvg(segs, { viewportW: 800, viewportH: 600 });
    // Composite inner-SVG height = 2400 (scroll range) + 600 (viewport) = 3000.
    expect(svg).toMatch(/<svg [^>]*viewBox="0 0 800 3000"/);
  });

  it("axis=x produces a wide composite", () => {
    const segs: ScrollSegmentCapture[] = [
      { scrollX: 0,    scrollY: 0, segmentStartMs: 0,    segmentEndMs: 1000, tree: [el({ tag: "div", x: 0, y: 0 })], diffFromPrev: null },
      { scrollX: 1200, scrollY: 0, segmentStartMs: 1000, segmentEndMs: 3000, tree: [el({ tag: "div", x: 0, y: 0 })], diffFromPrev: null },
    ];
    const svg = composeScrollSvg(segs, { viewportW: 800, viewportH: 600, axis: "x" });
    expect(svg).toMatch(/<svg [^>]*viewBox="0 0 2000 600"/);   // 1200 + 800 = 2000
    expect(svg).toMatch(/transform: translate3d\(-/);
  });
});

// ── Capture stacking ────────────────────────────────────────────────────────

describe("composeScrollSvg: capture stacking", () => {
  it("each capture gets a transform(translate) wrapper at its scroll offset", () => {
    const segs: ScrollSegmentCapture[] = [
      makeSeg(0,    0,    1000, [el({ tag: "p", x: 0, y: 0, text: "first" })]),
      makeSeg(800,  1000, 3000, [el({ tag: "p", x: 0, y: 0, text: "second" })]),
    ];
    const svg = composeScrollSvg(segs, { viewportW: 800, viewportH: 600 });
    // Each segment may carry a `class="<animClass>-sN"` for DM-642
    // per-segment culling, but its `transform="translate(...)"` is still
    // present on the wrapper.
    expect(svg).toMatch(/<g (?:class="[^"]+" )?transform="translate\(0 0\)">/);
    expect(svg).toMatch(/<g (?:class="[^"]+" )?transform="translate\(0 800\)">/);
  });

  it("axis=x stacks horizontally", () => {
    const segs: ScrollSegmentCapture[] = [
      { scrollX: 0,    scrollY: 0, segmentStartMs: 0,    segmentEndMs: 1000, tree: [el({ tag: "div", x: 0, y: 0 })], diffFromPrev: null },
      { scrollX: 400,  scrollY: 0, segmentStartMs: 1000, segmentEndMs: 3000, tree: [el({ tag: "div", x: 0, y: 0 })], diffFromPrev: null },
    ];
    const svg = composeScrollSvg(segs, { viewportW: 800, viewportH: 600, axis: "x" });
    expect(svg).toMatch(/<g (?:class="[^"]+" )?transform="translate\(0 0\)">/);
    expect(svg).toMatch(/<g (?:class="[^"]+" )?transform="translate\(400 0\)">/);
  });
});

// ── Keyframe timing ────────────────────────────────────────────────────────

describe("composeScrollSvg: keyframe timing", () => {
  it("stops appear at each segment's endMs as a percentage of total", () => {
    const segs: ScrollSegmentCapture[] = [
      makeSeg(0,    0,    1000),
      makeSeg(600,  1000, 4000),
      makeSeg(1200, 4000, 5000),
    ];
    const svg = composeScrollSvg(segs, { viewportW: 800, viewportH: 600 });
    // 1000/5000 = 20%, 4000/5000 = 80%, 5000/5000 = 100%.
    expect(svg).toMatch(/20\.000% \{ transform: translate3d\(0, -0\.000px, 0\);/);
    expect(svg).toMatch(/80\.000% \{ transform: translate3d\(0, -600\.000px, 0\);/);
    expect(svg).toMatch(/100\.000% \{ transform: translate3d\(0, -1200\.000px, 0\);/);
  });

  it("animation-duration matches the total scene time", () => {
    const segs: ScrollSegmentCapture[] = [
      makeSeg(0,   0,    2500),
      makeSeg(800, 2500, 7500),
    ];
    const svg = composeScrollSvg(segs, { viewportW: 800, viewportH: 600 });
    expect(svg).toMatch(/animation: scrl-\w+ 7\.500s linear infinite/);
  });
});

// ── Min-offset normalisation ───────────────────────────────────────────────

describe("composeScrollSvg: min-offset normalisation", () => {
  it("non-zero start scroll-y is normalised to composite y=0", () => {
    // Captures start at scrollY=500 (e.g. user passed `--scroll-start 500px`).
    const segs: ScrollSegmentCapture[] = [
      makeSeg(500,  0,    1000),
      makeSeg(1500, 1000, 3000),
    ];
    const svg = composeScrollSvg(segs, { viewportW: 800, viewportH: 600 });
    // First capture sits at composite y=0; second at y=1000. Per-segment
    // wrappers may carry a DM-642 cull class — the transform attr survives.
    expect(svg).toMatch(/<g (?:class="[^"]+" )?transform="translate\(0 0\)">/);
    expect(svg).toMatch(/<g (?:class="[^"]+" )?transform="translate\(0 1000\)">/);
    // Keyframes: first stop at offset 0, last at 1000.
    expect(svg).toMatch(/0\.000% \{ transform: translate3d\(0, -0\.000px, 0\);/);
    expect(svg).toMatch(/100\.000% \{ transform: translate3d\(0, -1000\.000px, 0\);/);
  });
});

// ── Runtime perf optimisations (DM-642) ────────────────────────────────────

describe("composeScrollSvg: runtime-perf optimisations", () => {
  it("hints GPU compositing via translate3d + will-change", () => {
    const segs: ScrollSegmentCapture[] = [
      makeSeg(0,   0,    1000),
      makeSeg(800, 1000, 2000),
    ];
    const svg = composeScrollSvg(segs, { viewportW: 800, viewportH: 600 });
    // The animated transform must use translate3d so Chromium promotes the
    // group to a compositing layer.
    expect(svg).toContain("translate3d(");
    expect(svg).not.toMatch(/transform: translateY\(/);
    // `will-change: transform` is set on the animation class.
    expect(svg).toMatch(/animation: scrl-\w+ [\d.]+s linear infinite; will-change: transform;/);
  });

  it("emits per-segment visibility-keyframes that hide off-window segments", () => {
    // Five segments at uniform 600px (=VH) spacing means each segment is
    // visible for at most ~2 segment-windows; the others are visibility:
    // hidden (DM-641 — was `display: none`, broke infinite anims).
    const segs: ScrollSegmentCapture[] = [
      makeSeg(0,    0,    1000),
      makeSeg(600,  1000, 2000),
      makeSeg(1200, 2000, 3000),
      makeSeg(1800, 3000, 4000),
      makeSeg(2400, 4000, 5000),
    ];
    const svg = composeScrollSvg(segs, { viewportW: 800, viewportH: 600 });
    // At least one segment is gated by a `visibility: hidden` keyframe.
    expect(svg).toMatch(/visibility: hidden/);
    // Must NOT use `display` toggles (DM-641).
    expect(svg).not.toMatch(/display: none/);
    expect(svg).not.toMatch(/display: inline/);
    // One `-sN` class per segment-with-cull.
    const cullClasses = svg.match(/scrl-\w+-s\d+/g) ?? [];
    expect(cullClasses.length).toBeGreaterThan(0);
  });

  it("does not cull a segment that's visible for the entire cycle", () => {
    // Two-segment input where the second has scrollY very close to first =>
    // each segment stays in the viewport across the whole cycle. No cull
    // class should be emitted in that case.
    const segs: ScrollSegmentCapture[] = [
      makeSeg(0,   0,    1000),
      makeSeg(100, 1000, 2000), // 100 < VH (600) so segment 0 never leaves viewport
    ];
    const svg = composeScrollSvg(segs, { viewportW: 800, viewportH: 600 });
    // Segment 0 keeps a plain (un-classed) wrapper because it's always visible.
    expect(svg).toMatch(/<g transform="translate\(0 0\)">/);
  });
});

// ── Chunked compositing layers (DM-648) ────────────────────────────────────

describe("composeScrollSvg: chunked composite layers", () => {
  function manySegs(count: number, viewportH: number = 600): ScrollSegmentCapture[] {
    const out: ScrollSegmentCapture[] = [];
    for (let i = 0; i < count; i++) {
      out.push(makeSeg(i * viewportH, i * 1000, (i + 1) * 1000));
    }
    return out;
  }

  it("8 segments produce 4 chunk wrappers, 2 inner segments each (default chunkSize=2)", () => {
    const svg = composeScrollSvg(manySegs(8), { viewportW: 800, viewportH: 600 });
    const chunkOpens = (svg.match(/<g style="will-change: transform">/g) ?? []).length;
    expect(chunkOpens).toBe(4);
    // Each chunk should have 2 inner segment wrappers; total inner segments = 8.
    const innerSegs = (svg.match(/<g (?:class="[^"]+" )?transform="translate\(0 \d+\)">/g) ?? []).length;
    expect(innerSegs).toBe(8);
  });

  it("2 segments stay in a single chunk wrapper", () => {
    const svg = composeScrollSvg(manySegs(2), { viewportW: 800, viewportH: 600 });
    const chunkOpens = (svg.match(/<g style="will-change: transform">/g) ?? []).length;
    expect(chunkOpens).toBe(1);
  });

  it("chunkSize: 1 puts each segment on its own layer", () => {
    const svg = composeScrollSvg(manySegs(5), { viewportW: 800, viewportH: 600, chunkSize: 1 });
    const chunkOpens = (svg.match(/<g style="will-change: transform">/g) ?? []).length;
    expect(chunkOpens).toBe(5);
  });

  it("trailing partial chunk: 7 segments at chunkSize=2 produce 4 chunks (3 full + 1 of size 1)", () => {
    const svg = composeScrollSvg(manySegs(7), { viewportW: 800, viewportH: 600 });
    const chunkOpens = (svg.match(/<g style="will-change: transform">/g) ?? []).length;
    expect(chunkOpens).toBe(4);
    const innerSegs = (svg.match(/<g (?:class="[^"]+" )?transform="translate\(0 \d+\)">/g) ?? []).length;
    expect(innerSegs).toBe(7);
  });

  it("DM-642 cull classes still emit on inner segments inside chunks", () => {
    // 5 segments at uniform 600px spacing → segments 2, 3 should be off-window
    // most of the cycle and get cull classes.
    const svg = composeScrollSvg(manySegs(5), { viewportW: 800, viewportH: 600 });
    // At least one `scrl-…-sN` cull class appears, and at least one
    // appears INSIDE a chunk wrapper (substring after the first chunk
    // open before that chunk's close).
    expect(svg).toMatch(/<g style="will-change: transform">[\s\S]*<g class="scrl-\w+-s\d+"/);
  });

  it("chunkSize must be a positive integer", () => {
    const segs = manySegs(2);
    expect(() => composeScrollSvg(segs, { viewportW: 800, viewportH: 600, chunkSize: 0 })).toThrow(/positive integer/);
    expect(() => composeScrollSvg(segs, { viewportW: 800, viewportH: 600, chunkSize: -1 })).toThrow(/positive integer/);
    expect(() => composeScrollSvg(segs, { viewportW: 800, viewportH: 600, chunkSize: 1.5 })).toThrow(/positive integer/);
  });

  it("fixed overlay is emitted OUTSIDE chunk wrappers (after the scrolling composite)", () => {
    const headerFixed = el({
      tag: "header", x: 0, y: 0, width: 800, height: 60,
      text: "BRAND",
      styles: { position: "fixed" } as CapturedElement["styles"],
    });
    const segs: ScrollSegmentCapture[] = [
      makeSeg(0,   0,    1000, [headerFixed, el({ tag: "section", x: 0, y: 100 })]),
      makeSeg(600, 1000, 2000, [headerFixed, el({ tag: "section", x: 0, y: 100 })]),
    ];
    const svg = composeScrollSvg(segs, { viewportW: 800, viewportH: 600 });
    // BRAND appears in the overlay; it must come AFTER the last
    // will-change chunk wrapper.
    const lastChunkIdx = svg.lastIndexOf('style="will-change: transform"');
    const brandIdx = svg.indexOf("BRAND");
    expect(lastChunkIdx).toBeGreaterThan(-1);
    expect(brandIdx).toBeGreaterThan(lastChunkIdx);
  });
});

// ── Fixed element hoisting (DM-643) ────────────────────────────────────────

describe("composeScrollSvg: position:fixed hoisting", () => {
  function headerEl(): CapturedElement {
    return el({
      tag: "header", x: 0, y: 0, width: 800, height: 60,
      text: "BRAND",
      styles: { position: "fixed" } as CapturedElement["styles"],
    });
  }

  it("emits a fixed-position element exactly once even across many segments", () => {
    // Three segment captures, each containing the same fixed header in addition
    // to its own body content. Without hoisting, the SVG would contain three
    // copies of the header — one per segment, each pinned to its segment's
    // composite-y offset — and the consumer would see the header re-appear
    // every viewport height during scroll.
    const segs: ScrollSegmentCapture[] = [
      makeSeg(0,    0,    1000, [headerEl(), el({ tag: "section", x: 0, y: 100, text: "alpha" })]),
      makeSeg(600,  1000, 2000, [headerEl(), el({ tag: "section", x: 0, y: 100, text: "beta"  })]),
      makeSeg(1200, 2000, 3000, [headerEl(), el({ tag: "section", x: 0, y: 100, text: "gamma" })]),
    ];
    const svg = composeScrollSvg(segs, { viewportW: 800, viewportH: 600 });
    // The number of "BRAND" substrings emitted per rendered header is
    // platform-dependent: glyph-path mode (system fonts present, e.g. macOS)
    // emits the text twice — once as `aria-label` and once as <title> — while
    // the `<text>` fallback (no host system fonts, e.g. Linux CI) emits it
    // once. So pin the invariant to "rendered exactly once after hoisting"
    // rather than to a fixed literal count: derive the per-render hit count
    // from a single-segment baseline and assert the three-segment compose
    // matches it. Without the fix this would be 3× the baseline (one rendered
    // header per segment).
    const baselineSvg = composeScrollSvg(
      [makeSeg(0, 0, 1000, [headerEl(), el({ tag: "section", x: 0, y: 100, text: "alpha" })])],
      { viewportW: 800, viewportH: 600 },
    );
    const perRenderHits = (baselineSvg.match(/BRAND/g) ?? []).length;
    const brandHits = (svg.match(/BRAND/g) ?? []).length;
    expect(perRenderHits, "single-segment baseline should render the header at least once").toBeGreaterThan(0);
    expect(brandHits, "header should render exactly once (not once per segment) after hoisting").toBe(perRenderHits);
    // Per-segment bodies still appear.
    expect(svg).toContain("alpha");
    expect(svg).toContain("beta");
    expect(svg).toContain("gamma");
  });

  it("renders the hoisted fixed element after the scrolling composite (sits above it)", () => {
    // The fixed overlay should appear in the SVG source AFTER the scrolling
    // `<g class="${animClass}">` block — that's the consumer's z-order.
    const segs: ScrollSegmentCapture[] = [
      makeSeg(0,    0,    1000, [headerEl(), el({ tag: "section", x: 0, y: 100 })]),
      makeSeg(600,  1000, 2000, [headerEl(), el({ tag: "section", x: 0, y: 100 })]),
    ];
    const svg = composeScrollSvg(segs, { viewportW: 800, viewportH: 600 });
    const scrollOpenIdx = svg.indexOf('class="scrl-');
    const fixedIdx = svg.indexOf("BRAND");
    expect(scrollOpenIdx).toBeGreaterThan(-1);
    expect(fixedIdx).toBeGreaterThan(scrollOpenIdx);
  });

  it("is a no-op when no segment contains a position:fixed element", () => {
    const segs: ScrollSegmentCapture[] = [
      makeSeg(0,   0,    1000, [el({ tag: "section", x: 0, y: 100 })]),
      makeSeg(600, 1000, 2000, [el({ tag: "section", x: 0, y: 100 })]),
    ];
    const svg = composeScrollSvg(segs, { viewportW: 800, viewportH: 600 });
    // No `fix-` id prefix (used only by the hoisted overlay).
    expect(svg).not.toContain('id="fix-');
  });
});

// ── Sticky element hoisting (DM-647) ───────────────────────────────────────

describe("composeScrollSvg: position:sticky hoisting", () => {
  it("mid-scroll sticky: element renders inline for in-flow segs AND on overlay for stuck segs (with visibility class)", () => {
    // Seg 0–1: nav is in flow (y decreases). Seg 2–3: stuck at y=0.
    const stickyNav = (y: number): CapturedElement => el({
      tag: "nav", x: 0, y, width: 800, height: 50, text: "STICKY-NAV",
      styles: { position: "sticky" } as CapturedElement["styles"],
    });
    const body = (y: number): CapturedElement => el({
      tag: "section", x: 0, y: 60, text: "main",
    });
    const segs: ScrollSegmentCapture[] = [
      makeSeg(0,    0,    1000, [stickyNav(300), body(0)]),
      makeSeg(600,  1000, 2000, [stickyNav(150), body(0)]),
      makeSeg(1200, 2000, 3000, [stickyNav(0),   body(0)]),
      makeSeg(1800, 3000, 4000, [stickyNav(0),   body(0)]),
    ];
    const svg = composeScrollSvg(segs, { viewportW: 800, viewportH: 600 });
    // The nav text appears at MOST twice from segs 0–1 (inline inside the
    // composite) plus twice from a single overlay render (aria-label +
    // <title>) — total ≥ 6 substring hits.
    // Critically, an overlay class for the sticky window has been
    // emitted: a `scrl-…-kN` keyframe is present.
    expect(svg).toMatch(/@keyframes scrl-\w+-k\d+ \{/);
    expect(svg).toMatch(/\.scrl-\w+-k\d+ \{ animation:/);
    // DM-641: no display-toggles slipped in via the sticky path.
    expect(svg).not.toMatch(/display: none/);
    expect(svg).not.toMatch(/display: inline/);
  });

  it("mixed fixed + sticky in one fixture: both overlays emit, no regression on DM-643", () => {
    const fixedHeader = (): CapturedElement => el({
      tag: "header", x: 0, y: 0, width: 800, height: 60, text: "FIXED-HEADER",
      styles: { position: "fixed" } as CapturedElement["styles"],
    });
    const stickyNav = (y: number): CapturedElement => el({
      tag: "nav", x: 0, y, width: 800, height: 50, text: "STICKY-NAV",
      styles: { position: "sticky" } as CapturedElement["styles"],
    });
    const segs: ScrollSegmentCapture[] = [
      makeSeg(0,    0,    1000, [fixedHeader(), stickyNav(300), el({ tag: "main", x: 0, y: 100 })]),
      makeSeg(600,  1000, 2000, [fixedHeader(), stickyNav(150), el({ tag: "main", x: 0, y: 100 })]),
      makeSeg(1200, 2000, 3000, [fixedHeader(), stickyNav(60),  el({ tag: "main", x: 0, y: 100 })]),
      makeSeg(1800, 3000, 4000, [fixedHeader(), stickyNav(60),  el({ tag: "main", x: 0, y: 100 })]),
    ];
    const svg = composeScrollSvg(segs, { viewportW: 800, viewportH: 600 });
    // DM-643 fixed-header path: present once.
    expect(svg).toContain("FIXED-HEADER");
    // DM-647 sticky overlay: keyframe class emitted.
    expect(svg).toMatch(/@keyframes scrl-\w+-k\d+ \{/);
    // The fixed-header BRAND substring (`fix-` prefix) and the sticky-nav
    // prefix `stk0-` both end up inside the overlay block AFTER the
    // last chunk wrapper (DM-648 didn't move overlays into chunks).
    const lastChunkIdx = svg.lastIndexOf('style="will-change: transform"');
    expect(svg.lastIndexOf("FIXED-HEADER")).toBeGreaterThan(lastChunkIdx);
    // The sticky nav appears INLINE in the in-flow segments (early in the
    // SVG, inside chunks) AND on the overlay (after all chunks). The
    // overlay occurrence is what we're checking for here.
    expect(svg.lastIndexOf("STICKY-NAV")).toBeGreaterThan(lastChunkIdx);
  });

  it("no sticky elements: no `scrl-…-k` keyframes, no `stk0-` markup", () => {
    const segs: ScrollSegmentCapture[] = [
      makeSeg(0,   0,    1000, [el({ tag: "main", x: 0, y: 0 })]),
      makeSeg(600, 1000, 2000, [el({ tag: "main", x: 0, y: 0 })]),
    ];
    const svg = composeScrollSvg(segs, { viewportW: 800, viewportH: 600 });
    expect(svg).not.toMatch(/scrl-\w+-k\d+/);
    expect(svg).not.toContain('id="stk0-');
  });
});

// ── Background colour override ─────────────────────────────────────────────

describe("composeScrollSvg: background colour", () => {
  // Build a segment whose captured root carries `rootBgComputed` (the value the
  // capture script stamps from getComputedStyle(documentElement).backgroundColor).
  const segWithRootBg = (rootBgComputed: string): ScrollSegmentCapture =>
    makeSeg(0, 0, 0, [el({ tag: "div", x: 0, y: 0, styles: { rootBgComputed } as CapturedElement["styles"] })]);

  // DM-894: the bug was a hardcoded `#0d1117` default. The default must now be
  // transparent — no canvas rect — when nothing supplies a background, so a
  // transparent capture composites over a host page instead of a dark box.
  it("no background by default — never the old hardcoded #0d1117 (DM-894)", () => {
    const svg = composeScrollSvg([makeSeg(0, 0, 0)], { viewportW: 800, viewportH: 600 });
    expect(svg).not.toContain('fill="#0d1117"');
    expect(svg).not.toMatch(/<rect width="800" height="600" fill=/); // no opaque viewport backdrop
  });

  it("derives the canvas background from the captured page root background (DM-894)", () => {
    const svg = composeScrollSvg([segWithRootBg("rgb(255, 255, 255)")], { viewportW: 800, viewportH: 600 });
    expect(svg).toContain('fill="rgb(255, 255, 255)"');
  });

  it("a transparent captured root paints no background rect (DM-894)", () => {
    for (const transparent of ["rgba(0, 0, 0, 0)", "transparent"]) {
      const svg = composeScrollSvg([segWithRootBg(transparent)], { viewportW: 800, viewportH: 600 });
      expect(svg).not.toMatch(/<rect width="800" height="600" fill=/);
      expect(svg).not.toContain('fill="#0d1117"');
    }
  });

  it("explicit bgColor is honored and wins over the captured root bg", () => {
    const svg = composeScrollSvg([segWithRootBg("rgb(255, 255, 255)")], { viewportW: 800, viewportH: 600, bgColor: "#ff8800" });
    expect(svg).toContain('fill="#ff8800"');
    expect(svg).not.toContain('fill="rgb(255, 255, 255)"');
  });

  it("explicit transparent bgColor paints no background rect", () => {
    const svg = composeScrollSvg([segWithRootBg("rgb(255, 255, 255)")], { viewportW: 800, viewportH: 600, bgColor: "transparent" });
    expect(svg).not.toMatch(/<rect width="800" height="600" fill=/);
  });
});

// ── DM-652: embedded-font render mode ──────────────────────────────────────

describe("composeScrollSvg: renderText option", () => {
  // No webfonts registered in this fixture, so all three modes fall
  // through to glyph-path emission — none of them produce a `@font-face`
  // block. These tests pin the SVG-shape invariants rather than the
  // observable mode-switching (which needs a fixture with a registered
  // webfont; covered indirectly via the real-world suite).
  it("default (renderText omitted): SVG renders without crashing", () => {
    const svg = composeScrollSvg([makeSeg(0, 0, 0)], { viewportW: 800, viewportH: 600 });
    expect(svg).toMatch(/<svg [^>]*viewBox="0 0 800 600"/);
    expect(svg).not.toContain("@font-face");
  });

  it("renderText: 'paths' explicit: no @font-face block emitted", () => {
    const svg = composeScrollSvg([makeSeg(0, 0, 0)], { viewportW: 800, viewportH: 600, renderText: "paths" });
    expect(svg).not.toContain("@font-face");
  });

  it("renderText: 'embedded-font' with no registered webfonts: still no @font-face (system fonts stay on paths fallback)", () => {
    // No registerWebfont call → the embedded-font branch in renderTextAsPath
    // can't find a webfont buffer, so the fixture text falls through to
    // glyph-path rendering exactly as if renderText="paths" were set.
    const svg = composeScrollSvg([makeSeg(0, 0, 0)], { viewportW: 800, viewportH: 600, renderText: "embedded-font" });
    expect(svg).not.toContain("@font-face");
  });
});
