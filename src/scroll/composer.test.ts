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
    expect(svg).toMatch(/20\.000% \{ transform: translateY\(/);
    expect(svg).toMatch(/60\.000% \{ transform: translateY\(/);
    expect(svg).toMatch(/100\.000% \{ transform: translateY\(/);
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
    expect(svg).toMatch(/transform: translateX\(/);
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
    expect(svg).toContain(`<g transform="translate(0 0)">`);
    expect(svg).toContain(`<g transform="translate(0 800)">`);
  });

  it("axis=x stacks horizontally", () => {
    const segs: ScrollSegmentCapture[] = [
      { scrollX: 0,    scrollY: 0, segmentStartMs: 0,    segmentEndMs: 1000, tree: [el({ tag: "div", x: 0, y: 0 })], diffFromPrev: null },
      { scrollX: 400,  scrollY: 0, segmentStartMs: 1000, segmentEndMs: 3000, tree: [el({ tag: "div", x: 0, y: 0 })], diffFromPrev: null },
    ];
    const svg = composeScrollSvg(segs, { viewportW: 800, viewportH: 600, axis: "x" });
    expect(svg).toContain(`<g transform="translate(0 0)">`);
    expect(svg).toContain(`<g transform="translate(400 0)">`);
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
    expect(svg).toMatch(/20\.000% \{ transform: translateY\(-0\.000px\);/);
    expect(svg).toMatch(/80\.000% \{ transform: translateY\(-600\.000px\);/);
    expect(svg).toMatch(/100\.000% \{ transform: translateY\(-1200\.000px\);/);
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
    // First capture sits at composite y=0; second at y=1000.
    expect(svg).toContain(`<g transform="translate(0 0)">`);
    expect(svg).toContain(`<g transform="translate(0 1000)">`);
    // Keyframes: first stop at offset 0, last at 1000.
    expect(svg).toMatch(/0\.000% \{ transform: translateY\(-0\.000px\);/);
    expect(svg).toMatch(/100\.000% \{ transform: translateY\(-1000\.000px\);/);
  });
});

// ── Background colour override ─────────────────────────────────────────────

describe("composeScrollSvg: background colour", () => {
  it("default bg is dark", () => {
    const svg = composeScrollSvg([makeSeg(0, 0, 0)], { viewportW: 800, viewportH: 600 });
    expect(svg).toContain('fill="#0d1117"');
  });

  it("custom bg is honored", () => {
    const svg = composeScrollSvg([makeSeg(0, 0, 0)], { viewportW: 800, viewportH: 600, bgColor: "#ffffff" });
    expect(svg).toContain('fill="#ffffff"');
  });
});
