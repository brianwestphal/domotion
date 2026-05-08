import { describe, expect, it } from "vitest";
import { elementTreeToSvg, type CapturedElement } from "./dom-to-svg.js";

/**
 * DM-473: cross-stacking-context z-index unit tests.
 *
 * These exercise `establishesStackingContext` + `gatherStackingContextChildren`
 * (both internal) by their observable effect on `elementTreeToSvg` output:
 * the relative DOM order of `fill="rgb(...)"` rect emissions in the SVG
 * string equals the paint order Chromium would use. The colours are unique
 * per scenario so the fixture under test only needs to verify each colour
 * appears in the expected sequence.
 *
 * Pairs with the integration fixtures in `tests/features.ts` (see the
 * `z-index-cross-parent-non-context` / `z-index-stacking-context-boundary` /
 * `z-index-negative-escapes` / `z-index-transform-stacking-context` blocks).
 */

function makeElement(overrides: Partial<CapturedElement> = {}): CapturedElement {
  return {
    tag: "div",
    text: "",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    children: [],
    ...overrides,
    styles: {
      backgroundColor: "rgb(255,255,255)",
      borderColor: "rgb(0,0,0)",
      borderWidth: "0",
      borderRadius: "0",
      borderTopLeftRadius: "0",
      borderTopRightRadius: "0",
      borderBottomRightRadius: "0",
      borderBottomLeftRadius: "0",
      borderTopWidth: "0",
      borderRightWidth: "0",
      borderBottomWidth: "0",
      borderLeftWidth: "0",
      borderTopColor: "rgb(0,0,0)",
      borderRightColor: "rgb(0,0,0)",
      borderBottomColor: "rgb(0,0,0)",
      borderLeftColor: "rgb(0,0,0)",
      borderTopStyle: "none",
      borderRightStyle: "none",
      borderBottomStyle: "none",
      borderLeftStyle: "none",
      color: "rgb(0,0,0)",
      fontSize: "16px",
      fontFamily: "sans-serif",
      fontWeight: "400",
      fontStyle: "normal",
      lineHeight: "20px",
      letterSpacing: "normal",
      textAlign: "left",
      textTransform: "none",
      textDecoration: "none",
      textDecorationLine: "none",
      textDecorationStyle: "solid",
      textDecorationColor: "rgb(0,0,0)",
      textDecorationThickness: "auto",
      textUnderlineOffset: "auto",
      whiteSpace: "normal",
      wordSpacing: "0",
      verticalAlign: "baseline",
      direction: "ltr",
      writingMode: "horizontal-tb",
      textOverflow: "clip",
      cursor: "auto",
      caretColor: "auto",
      outlineColor: "rgb(0,0,0)",
      outlineWidth: "0",
      outlineStyle: "none",
      outlineOffset: "0",
      boxShadow: "none",
      opacity: "1",
      transform: "none",
      transformOrigin: "50% 50%",
      visibility: "visible",
      borderCollapse: "separate",
      overflowX: "visible",
      overflowY: "visible",
      scrollbarGutter: "auto",
      scrollWidth: 100,
      scrollHeight: 100,
      clientWidth: 100,
      clientHeight: 100,
      scrollTop: 0,
      scrollLeft: 0,
      objectFit: "fill",
      objectPosition: "50% 50%",
      filter: "none",
      backdropFilter: "none",
      mixBlendMode: "normal",
      clipPath: "none",
      mask: "none",
      maskImage: "none",
      maskMode: "match-source",
      maskSize: "auto",
      maskPosition: "0% 0%",
      maskRepeat: "repeat",
      maskComposite: "add",
      listStyleType: "disc",
      listStyleImage: "none",
      display: "block",
      listStylePosition: "outside",
      backgroundImage: "none",
      backgroundSize: "auto",
      backgroundPosition: "0% 0%",
      backgroundRepeat: "repeat",
      backgroundClip: "border-box",
      backgroundOrigin: "padding-box",
      backgroundAttachment: "scroll",
      paddingTop: "0",
      paddingRight: "0",
      paddingBottom: "0",
      paddingLeft: "0",
      borderImageSource: "none",
      borderImageSlice: "100%",
      borderImageWidth: "1",
      borderImageOutset: "0",
      borderImageRepeat: "stretch",
      zIndex: "auto",
      position: "static",
      float: "none",
      order: "0",
      flexDirection: "row",
      ...(overrides.styles ?? {}),
    } as CapturedElement["styles"],
  };
}

/** Returns the order of `fill="<color>"` occurrences in the SVG. */
function fillOrder(svg: string, colors: string[]): string[] {
  const positions = colors
    .map((c) => ({ c, i: svg.indexOf(`fill="${c}"`) }))
    .filter((p) => p.i >= 0)
    .sort((a, b) => a.i - b.i);
  return positions.map((p) => p.c);
}

describe("DM-473 stacking-context paint order — cross-parent z-index", () => {
  it("hoists positioned grandchild with z-index>0 above ancestor's later sibling when ancestor is non-SC", () => {
    // Tree:
    //   root (relative)
    //   ├── red    (absolute, z:auto, NOT SC)        — bucket: zero/auto
    //   │   └── blue  (absolute, z:1, SC)           — hoists to root, bucket: positive(1)
    //   └── green  (absolute, z:auto, NOT SC)       — bucket: zero/auto, after red in DOM
    //
    // Paint order: bg → red → green → blue (blue hoists into positive(1) bucket
    // so it paints AFTER both auto-bucket positioned siblings).
    const tree = [makeElement({
      x: 0, y: 0, width: 240, height: 160,
      styles: { ...makeElement().styles, position: "relative", backgroundColor: "rgb(13,17,23)" },
      children: [
        makeElement({
          x: 10, y: 10, width: 120, height: 120,
          styles: { ...makeElement().styles, position: "absolute", backgroundColor: "rgb(220,38,38)" },
          children: [
            makeElement({
              x: 40, y: 40, width: 140, height: 90,
              styles: { ...makeElement().styles, position: "absolute", zIndex: "1", backgroundColor: "rgb(88,166,255)" },
            }),
          ],
        }),
        makeElement({
          x: 80, y: 50, width: 140, height: 80,
          styles: { ...makeElement().styles, position: "absolute", backgroundColor: "rgb(63,185,80)" },
        }),
      ],
    })];

    const svg = elementTreeToSvg(tree, 240, 160);
    const order = fillOrder(svg, ["rgb(220,38,38)", "rgb(63,185,80)", "rgb(88,166,255)"]);
    expect(order).toEqual([
      "rgb(220,38,38)", // red painted first (z:auto, DOM order)
      "rgb(63,185,80)", // green next (z:auto, after red)
      "rgb(88,166,255)", // blue hoisted to positive(1) bucket — paints last
    ]);
  });

  it("respects stacking-context boundary: z-index>5 inside SC doesn't escape to root", () => {
    // Tree:
    //   root
    //   ├── red    (absolute, z:1, IS SC)          — bucket: positive(1)
    //   │   └── blue  (absolute, z:5, SC)          — STAYS inside red's SC
    //   └── green  (absolute, z:2, IS SC)          — bucket: positive(2), paints after red
    //
    // Paint order: red → blue (inside red) → green
    const tree = [makeElement({
      x: 0, y: 0, width: 240, height: 160,
      styles: { ...makeElement().styles, position: "relative", backgroundColor: "rgb(13,17,23)" },
      children: [
        makeElement({
          x: 10, y: 10, width: 120, height: 120,
          styles: { ...makeElement().styles, position: "absolute", zIndex: "1", backgroundColor: "rgb(220,38,38)" },
          children: [
            makeElement({
              x: 40, y: 40, width: 140, height: 90,
              styles: { ...makeElement().styles, position: "absolute", zIndex: "5", backgroundColor: "rgb(88,166,255)" },
            }),
          ],
        }),
        makeElement({
          x: 80, y: 50, width: 140, height: 80,
          styles: { ...makeElement().styles, position: "absolute", zIndex: "2", backgroundColor: "rgb(63,185,80)" },
        }),
      ],
    })];

    const svg = elementTreeToSvg(tree, 240, 160);
    const order = fillOrder(svg, ["rgb(220,38,38)", "rgb(88,166,255)", "rgb(63,185,80)"]);
    expect(order).toEqual([
      "rgb(220,38,38)", // red (z:1)
      "rgb(88,166,255)", // blue inside red — DFS continues inside SC
      "rgb(63,185,80)", // green (z:2) paints last
    ]);
  });

  it("transform creates a stacking context — descendants don't escape", () => {
    // Same shape as the boundary test but the SC root uses `transform`
    // instead of an explicit z-index.
    const tree = [makeElement({
      x: 0, y: 0, width: 240, height: 160,
      styles: { ...makeElement().styles, position: "relative", backgroundColor: "rgb(13,17,23)" },
      children: [
        makeElement({
          x: 10, y: 10, width: 120, height: 120,
          styles: {
            ...makeElement().styles,
            position: "absolute",
            transform: "translate(0px, 0px) matrix(1, 0, 0, 1, 0, 0)",
            transformOrigin: "60px 60px",
            backgroundColor: "rgb(220,38,38)",
          },
          children: [
            makeElement({
              x: 40, y: 40, width: 140, height: 90,
              styles: { ...makeElement().styles, position: "absolute", zIndex: "5", backgroundColor: "rgb(88,166,255)" },
            }),
          ],
        }),
        makeElement({
          x: 80, y: 50, width: 140, height: 80,
          styles: { ...makeElement().styles, position: "absolute", zIndex: "1", backgroundColor: "rgb(63,185,80)" },
        }),
      ],
    })];

    const svg = elementTreeToSvg(tree, 240, 160);
    const order = fillOrder(svg, ["rgb(220,38,38)", "rgb(88,166,255)", "rgb(63,185,80)"]);
    expect(order).toEqual([
      "rgb(220,38,38)", // red (transformed, SC root) — auto-z bucket at root
      "rgb(88,166,255)", // blue inside red's SC
      "rgb(63,185,80)", // green (z:1) paints last over both
    ]);
  });

  it("negative z-index hoists below ancestor's earlier in-flow content", () => {
    // Tree:
    //   root (relative)
    //   ├── gray  (absolute, z:auto)               — bucket: zero/auto
    //   └── red   (absolute, z:auto, NOT SC)       — bucket: zero/auto (after gray)
    //       └── blue (absolute, z:-1, SC)          — hoists to root, bucket: NEGATIVE
    //
    // Paint order: bg → blue (negative bucket, first) → gray → red.
    // Visually: blue paints behind both gray and red.
    const tree = [makeElement({
      x: 0, y: 0, width: 240, height: 160,
      styles: { ...makeElement().styles, position: "relative", backgroundColor: "rgb(13,17,23)" },
      children: [
        makeElement({
          x: 10, y: 10, width: 220, height: 50,
          styles: { ...makeElement().styles, position: "absolute", backgroundColor: "rgb(148,163,184)" },
        }),
        makeElement({
          x: 60, y: 40, width: 120, height: 80,
          styles: { ...makeElement().styles, position: "absolute", backgroundColor: "rgb(220,38,38)" },
          children: [
            makeElement({
              x: 30, y: 20, width: 200, height: 120,
              styles: { ...makeElement().styles, position: "absolute", zIndex: "-1", backgroundColor: "rgb(88,166,255)" },
            }),
          ],
        }),
      ],
    })];

    const svg = elementTreeToSvg(tree, 240, 160);
    const order = fillOrder(svg, ["rgb(88,166,255)", "rgb(148,163,184)", "rgb(220,38,38)"]);
    expect(order).toEqual([
      "rgb(88,166,255)", // blue (z:-1) hoisted to negative bucket — paints first
      "rgb(148,163,184)", // gray (z:auto)
      "rgb(220,38,38)", // red (z:auto, after gray in DOM)
    ]);
  });

  it("will-change: transform creates a stacking context (DM-498)", () => {
    // Apple-style hero pattern: artwork wrapper has `will-change: transform`
    // (no explicit transform value yet — author intends to animate). Per CSS
    // spec, this MUST create a stacking context. Without DM-498, Domotion
    // missed this and positioned descendants escaped past the wrapper into
    // the parent SC's flat list, disrupting paint order.
    const tree = [makeElement({
      x: 0, y: 0, width: 240, height: 160,
      styles: { ...makeElement().styles, position: "relative", backgroundColor: "rgb(13,17,23)" },
      children: [
        makeElement({
          x: 10, y: 10, width: 120, height: 120,
          styles: { ...makeElement().styles, position: "absolute", willChange: "transform", backgroundColor: "rgb(220,38,38)" },
          children: [
            makeElement({
              x: 40, y: 40, width: 140, height: 90,
              styles: { ...makeElement().styles, position: "absolute", zIndex: "5", backgroundColor: "rgb(88,166,255)" },
            }),
          ],
        }),
        makeElement({
          x: 80, y: 50, width: 140, height: 80,
          styles: { ...makeElement().styles, position: "absolute", zIndex: "1", backgroundColor: "rgb(63,185,80)" },
        }),
      ],
    })];

    const svg = elementTreeToSvg(tree, 240, 160);
    const order = fillOrder(svg, ["rgb(220,38,38)", "rgb(88,166,255)", "rgb(63,185,80)"]);
    expect(order).toEqual([
      "rgb(220,38,38)", // will-change wrapper (auto-z bucket at root, paints first)
      "rgb(88,166,255)", // blue trapped INSIDE the SC
      "rgb(63,185,80)", // green (z:1) paints last via positive bucket
    ]);
  });

  it("contain: paint creates a stacking context (DM-498)", () => {
    // `contain: paint | strict | content` per CSS Containment spec creates
    // a stacking context. Mirrors the will-change test — descendants stay
    // inside.
    const tree = [makeElement({
      x: 0, y: 0, width: 240, height: 160,
      styles: { ...makeElement().styles, position: "relative", backgroundColor: "rgb(13,17,23)" },
      children: [
        makeElement({
          x: 10, y: 10, width: 120, height: 120,
          styles: { ...makeElement().styles, position: "absolute", contain: "paint", backgroundColor: "rgb(220,38,38)" },
          children: [
            makeElement({
              x: 40, y: 40, width: 140, height: 90,
              styles: { ...makeElement().styles, position: "absolute", zIndex: "5", backgroundColor: "rgb(88,166,255)" },
            }),
          ],
        }),
        makeElement({
          x: 80, y: 50, width: 140, height: 80,
          styles: { ...makeElement().styles, position: "absolute", zIndex: "1", backgroundColor: "rgb(63,185,80)" },
        }),
      ],
    })];

    const svg = elementTreeToSvg(tree, 240, 160);
    const order = fillOrder(svg, ["rgb(220,38,38)", "rgb(88,166,255)", "rgb(63,185,80)"]);
    expect(order).toEqual([
      "rgb(220,38,38)",
      "rgb(88,166,255)",
      "rgb(63,185,80)",
    ]);
  });

  it("isolation: isolate creates a stacking context (DM-498)", () => {
    const tree = [makeElement({
      x: 0, y: 0, width: 240, height: 160,
      styles: { ...makeElement().styles, position: "relative", backgroundColor: "rgb(13,17,23)" },
      children: [
        makeElement({
          x: 10, y: 10, width: 120, height: 120,
          styles: { ...makeElement().styles, position: "absolute", isolation: "isolate", backgroundColor: "rgb(220,38,38)" },
          children: [
            makeElement({
              x: 40, y: 40, width: 140, height: 90,
              styles: { ...makeElement().styles, position: "absolute", zIndex: "5", backgroundColor: "rgb(88,166,255)" },
            }),
          ],
        }),
        makeElement({
          x: 80, y: 50, width: 140, height: 80,
          styles: { ...makeElement().styles, position: "absolute", zIndex: "1", backgroundColor: "rgb(63,185,80)" },
        }),
      ],
    })];

    const svg = elementTreeToSvg(tree, 240, 160);
    const order = fillOrder(svg, ["rgb(220,38,38)", "rgb(88,166,255)", "rgb(63,185,80)"]);
    expect(order).toEqual([
      "rgb(220,38,38)",
      "rgb(88,166,255)",
      "rgb(63,185,80)",
    ]);
  });

  it("will-change: scroll-position does NOT create a stacking context", () => {
    // CSS-Will-Change-1: only properties that themselves create SCs trigger
    // SC formation when listed in will-change. `scroll-position` is not such
    // a property — listing it should leave normal hoist behavior intact.
    const tree = [makeElement({
      x: 0, y: 0, width: 240, height: 160,
      styles: { ...makeElement().styles, position: "relative", backgroundColor: "rgb(13,17,23)" },
      children: [
        makeElement({
          x: 10, y: 10, width: 120, height: 120,
          styles: { ...makeElement().styles, position: "absolute", willChange: "scroll-position", backgroundColor: "rgb(220,38,38)" },
          children: [
            makeElement({
              x: 40, y: 40, width: 140, height: 90,
              // z-index:5, but parent is NOT an SC → blue hoists to root SC.
              styles: { ...makeElement().styles, position: "absolute", zIndex: "5", backgroundColor: "rgb(88,166,255)" },
            }),
          ],
        }),
        makeElement({
          x: 80, y: 50, width: 140, height: 80,
          styles: { ...makeElement().styles, position: "absolute", zIndex: "1", backgroundColor: "rgb(63,185,80)" },
        }),
      ],
    })];

    const svg = elementTreeToSvg(tree, 240, 160);
    const order = fillOrder(svg, ["rgb(220,38,38)", "rgb(88,166,255)", "rgb(63,185,80)"]);
    // blue (z:5 hoisted to root) paints LAST — over green (z:1).
    expect(order).toEqual([
      "rgb(220,38,38)",
      "rgb(63,185,80)",
      "rgb(88,166,255)",
    ]);
  });

  it("position:fixed/sticky always create a stacking context (modern CSS)", () => {
    // A fixed-positioned ancestor with z-index:auto still creates an SC
    // per the "modern CSS" rule. Its z-indexed descendants stay inside.
    const tree = [makeElement({
      x: 0, y: 0, width: 240, height: 160,
      styles: { ...makeElement().styles, position: "relative", backgroundColor: "rgb(13,17,23)" },
      children: [
        makeElement({
          x: 10, y: 10, width: 120, height: 120,
          styles: { ...makeElement().styles, position: "fixed", backgroundColor: "rgb(220,38,38)" },
          children: [
            makeElement({
              x: 40, y: 40, width: 140, height: 90,
              styles: { ...makeElement().styles, position: "absolute", zIndex: "5", backgroundColor: "rgb(88,166,255)" },
            }),
          ],
        }),
        makeElement({
          x: 80, y: 50, width: 140, height: 80,
          styles: { ...makeElement().styles, position: "absolute", zIndex: "1", backgroundColor: "rgb(63,185,80)" },
        }),
      ],
    })];

    const svg = elementTreeToSvg(tree, 240, 160);
    const order = fillOrder(svg, ["rgb(220,38,38)", "rgb(88,166,255)", "rgb(63,185,80)"]);
    expect(order).toEqual([
      "rgb(220,38,38)", // fixed red (auto-z bucket at root)
      "rgb(88,166,255)", // blue trapped inside red's SC
      "rgb(63,185,80)", // green (z:1) paints last
    ]);
  });
});

describe("DM-525 flex/grid item z-index — stacking context without explicit positioning", () => {
  // CSS Flexbox 1 §5.4 / CSS Grid 1: a flex/grid item with z-index ≠ auto
  // creates a stacking context even when position:static, behaving as if
  // position were relative. Without this, a static-positioned flex item
  // with z-index:10 would NOT z-sort, and DOM order alone would decide
  // overlapping paint — visible on `15-deep-flex-order-vs-z` (DM-525) where
  // `<div class="item a" style="z-index: 10">A</div>` should pop above its
  // overlapping siblings but Domotion painted it underneath.
  it("paints a flex item with z-index:10 ABOVE its later DOM-order siblings (default position:static)", () => {
    // Tree: a flex container with three static-positioned children.
    // The first child has z-index:10 — per spec, it should paint LAST.
    const tree = [makeElement({
      x: 0, y: 0, width: 300, height: 100,
      styles: { ...makeElement().styles, display: "flex", backgroundColor: "rgb(13,17,23)" },
      children: [
        makeElement({
          x: 0, y: 0, width: 100, height: 100,
          styles: { ...makeElement().styles, zIndex: "10", backgroundColor: "rgb(220,38,38)" }, // red, z:10
        }),
        makeElement({
          x: 100, y: 0, width: 100, height: 100,
          styles: { ...makeElement().styles, backgroundColor: "rgb(22,163,74)" }, // green, z:auto
        }),
        makeElement({
          x: 200, y: 0, width: 100, height: 100,
          styles: { ...makeElement().styles, backgroundColor: "rgb(37,99,235)" }, // blue, z:auto
        }),
      ],
    })];
    const svg = elementTreeToSvg(tree, 300, 100);
    const order = fillOrder(svg, ["rgb(220,38,38)", "rgb(22,163,74)", "rgb(37,99,235)"]);
    expect(order).toEqual([
      "rgb(22,163,74)", // green (auto)
      "rgb(37,99,235)", // blue (auto)
      "rgb(220,38,38)", // red z:10 — paints LAST
    ]);
  });

  it("z-sorts multiple flex items by their z-index, regardless of DOM order", () => {
    const tree = [makeElement({
      x: 0, y: 0, width: 300, height: 100,
      styles: { ...makeElement().styles, display: "flex", backgroundColor: "rgb(13,17,23)" },
      children: [
        // a: z:5 — should paint last
        makeElement({
          x: 0, y: 0, width: 100, height: 100,
          styles: { ...makeElement().styles, zIndex: "5", backgroundColor: "rgb(220,38,38)" },
        }),
        // b: z:1 — paints between auto-bucket and z:5
        makeElement({
          x: 100, y: 0, width: 100, height: 100,
          styles: { ...makeElement().styles, zIndex: "1", backgroundColor: "rgb(22,163,74)" },
        }),
        // c: z:auto — paints first (before any explicit-z item per CSS)
        makeElement({
          x: 200, y: 0, width: 100, height: 100,
          styles: { ...makeElement().styles, backgroundColor: "rgb(37,99,235)" },
        }),
      ],
    })];
    const svg = elementTreeToSvg(tree, 300, 100);
    const order = fillOrder(svg, ["rgb(220,38,38)", "rgb(22,163,74)", "rgb(37,99,235)"]);
    expect(order).toEqual([
      "rgb(37,99,235)", // c: auto-bucket
      "rgb(22,163,74)", // b: z:1
      "rgb(220,38,38)", // a: z:5 — last
    ]);
  });

  it("does NOT z-sort children of a non-flex/grid container with z-index (DOM order preserved)", () => {
    // Sanity check: a regular block container ignores z-index on static
    // children — they paint in DOM order.
    const tree = [makeElement({
      x: 0, y: 0, width: 300, height: 100,
      styles: { ...makeElement().styles, display: "block", backgroundColor: "rgb(13,17,23)" },
      children: [
        makeElement({
          x: 0, y: 0, width: 100, height: 100,
          styles: { ...makeElement().styles, zIndex: "10", backgroundColor: "rgb(220,38,38)" }, // red, z:10 IGNORED
        }),
        makeElement({
          x: 0, y: 0, width: 100, height: 100,
          styles: { ...makeElement().styles, backgroundColor: "rgb(22,163,74)" }, // green
        }),
      ],
    })];
    const svg = elementTreeToSvg(tree, 300, 100);
    const order = fillOrder(svg, ["rgb(220,38,38)", "rgb(22,163,74)"]);
    expect(order).toEqual([
      "rgb(220,38,38)", // DOM order: red first
      "rgb(22,163,74)", // green second
    ]);
  });

  it("treats grid items the same as flex items (display: grid)", () => {
    const tree = [makeElement({
      x: 0, y: 0, width: 300, height: 100,
      styles: { ...makeElement().styles, display: "grid", backgroundColor: "rgb(13,17,23)" },
      children: [
        makeElement({
          x: 0, y: 0, width: 100, height: 100,
          styles: { ...makeElement().styles, zIndex: "10", backgroundColor: "rgb(220,38,38)" },
        }),
        makeElement({
          x: 100, y: 0, width: 100, height: 100,
          styles: { ...makeElement().styles, backgroundColor: "rgb(22,163,74)" },
        }),
      ],
    })];
    const svg = elementTreeToSvg(tree, 300, 100);
    const order = fillOrder(svg, ["rgb(220,38,38)", "rgb(22,163,74)"]);
    expect(order).toEqual([
      "rgb(22,163,74)", // green (auto)
      "rgb(220,38,38)", // red z:10 — last
    ]);
  });
});

describe("DM-537 flex/grid `order` property — paint follows order-modified document order", () => {
  // CSS Flexbox 1 §5.4.1 / CSS Grid 1 §17: flex/grid items paint in
  // order-modified document order (ascending `order`, ties broken by source
  // order). The `order` property reorders both the visual layout AND the
  // paint stack. This is the residual bug in `15-deep-flex-order-vs-z`
  // section 2 after DM-525 fixed the explicit-z-index portion: items
  // `order: 5,4,3,2,1` reverse the visual layout so E (order:1) is leftmost
  // and A (order:5) is rightmost; with default z:auto Chrome paints E first
  // and A last (visual L-to-R order). Domotion was painting in DOM order
  // (A first, E last), which matched the source order rather than the
  // order-modified one — visible as colored stripes at the box-overlap
  // zones since the wrong sibling covered each overlap.

  it("paints flex items in ascending `order` value (default z:auto)", () => {
    // Tree: 5 flex items, A first in DOM with order:5 (visually rightmost)
    // through E last in DOM with order:1 (visually leftmost). Paint must
    // be E, D, C, B, A — visual L-to-R / order-modified.
    const tree = [makeElement({
      x: 0, y: 0, width: 600, height: 60,
      styles: { ...makeElement().styles, display: "flex", backgroundColor: "rgb(13,17,23)" },
      children: [
        makeElement({ x: 480, y: 0, width: 120, height: 60, styles: { ...makeElement().styles, order: "5", backgroundColor: "rgb(220,38,38)" } }), // A
        makeElement({ x: 360, y: 0, width: 120, height: 60, styles: { ...makeElement().styles, order: "4", backgroundColor: "rgb(22,163,74)" } }),  // B
        makeElement({ x: 240, y: 0, width: 120, height: 60, styles: { ...makeElement().styles, order: "3", backgroundColor: "rgb(37,99,235)" } }),  // C
        makeElement({ x: 120, y: 0, width: 120, height: 60, styles: { ...makeElement().styles, order: "2", backgroundColor: "rgb(234,88,12)" } }),  // D
        makeElement({ x: 0,   y: 0, width: 120, height: 60, styles: { ...makeElement().styles, order: "1", backgroundColor: "rgb(124,58,237)" } }), // E
      ],
    })];
    const svg = elementTreeToSvg(tree, 600, 60);
    const order = fillOrder(svg, [
      "rgb(220,38,38)", "rgb(22,163,74)", "rgb(37,99,235)", "rgb(234,88,12)", "rgb(124,58,237)",
    ]);
    expect(order).toEqual([
      "rgb(124,58,237)", // E (order:1) first
      "rgb(234,88,12)",  // D (order:2)
      "rgb(37,99,235)",  // C (order:3)
      "rgb(22,163,74)",  // B (order:4)
      "rgb(220,38,38)",  // A (order:5) last/top
    ]);
  });

  it("breaks `order` ties with source (DOM) order", () => {
    // Two items share order:0, two share order:1. Within each bucket the
    // painted-first is the one earlier in DOM order.
    const tree = [makeElement({
      x: 0, y: 0, width: 400, height: 60,
      styles: { ...makeElement().styles, display: "flex", backgroundColor: "rgb(13,17,23)" },
      children: [
        makeElement({ x: 0,   y: 0, width: 100, height: 60, styles: { ...makeElement().styles, order: "1", backgroundColor: "rgb(220,38,38)" } }), // red, order:1, DOM 0
        makeElement({ x: 100, y: 0, width: 100, height: 60, styles: { ...makeElement().styles, order: "0", backgroundColor: "rgb(22,163,74)" } }), // green, order:0, DOM 1
        makeElement({ x: 200, y: 0, width: 100, height: 60, styles: { ...makeElement().styles, order: "1", backgroundColor: "rgb(37,99,235)" } }), // blue, order:1, DOM 2
        makeElement({ x: 300, y: 0, width: 100, height: 60, styles: { ...makeElement().styles, order: "0", backgroundColor: "rgb(234,88,12)" } }), // orange, order:0, DOM 3
      ],
    })];
    const svg = elementTreeToSvg(tree, 400, 60);
    const order = fillOrder(svg, [
      "rgb(220,38,38)", "rgb(22,163,74)", "rgb(37,99,235)", "rgb(234,88,12)",
    ]);
    expect(order).toEqual([
      "rgb(22,163,74)",  // green (order:0, DOM 1) — first
      "rgb(234,88,12)",  // orange (order:0, DOM 3)
      "rgb(220,38,38)",  // red (order:1, DOM 0)
      "rgb(37,99,235)",  // blue (order:1, DOM 2) — last
    ]);
  });

  it("ignores `order` on children of a non-flex/non-grid container (DOM order preserved)", () => {
    // Plain block container — `order` has no effect.
    const tree = [makeElement({
      x: 0, y: 0, width: 200, height: 60,
      styles: { ...makeElement().styles, display: "block", backgroundColor: "rgb(13,17,23)" },
      children: [
        makeElement({ x: 0,   y: 0, width: 100, height: 60, styles: { ...makeElement().styles, order: "5", backgroundColor: "rgb(220,38,38)" } }),
        makeElement({ x: 100, y: 0, width: 100, height: 60, styles: { ...makeElement().styles, order: "1", backgroundColor: "rgb(22,163,74)" } }),
      ],
    })];
    const svg = elementTreeToSvg(tree, 200, 60);
    const order = fillOrder(svg, ["rgb(220,38,38)", "rgb(22,163,74)"]);
    expect(order).toEqual([
      "rgb(220,38,38)", // DOM order — `order` ignored
      "rgb(22,163,74)",
    ]);
  });

  it("reverses paint order for flex-direction:row-reverse (visually-rightmost paints last)", () => {
    // Section 3 of `15-deep-flex-order-vs-z`: 5 items in DOM order A,B,C,D,E
    // inside `flex-direction: row-reverse` with no `order` on items. Items
    // pack from main-start (right) so visual L-to-R is E,D,C,B,A. Chrome
    // empirically paints in REVERSE DOM order — E first, A last — which
    // ends up matching visual L-to-R. Without this rule Domotion painted
    // in source order (A first, E last) and the colored stripes at the
    // box-overlap zones diff'd because the wrong sibling owned each
    // overlap (DM-537 follow-up to DM-525).
    const tree = [makeElement({
      x: 0, y: 0, width: 600, height: 60,
      styles: { ...makeElement().styles, display: "flex", flexDirection: "row-reverse", backgroundColor: "rgb(13,17,23)" },
      children: [
        makeElement({ x: 480, y: 0, width: 120, height: 60, styles: { ...makeElement().styles, backgroundColor: "rgb(220,38,38)" } }), // A — DOM 0, visually rightmost
        makeElement({ x: 360, y: 0, width: 120, height: 60, styles: { ...makeElement().styles, backgroundColor: "rgb(22,163,74)" } }),  // B
        makeElement({ x: 240, y: 0, width: 120, height: 60, styles: { ...makeElement().styles, backgroundColor: "rgb(37,99,235)" } }),  // C
        makeElement({ x: 120, y: 0, width: 120, height: 60, styles: { ...makeElement().styles, backgroundColor: "rgb(234,88,12)" } }),  // D
        makeElement({ x: 0,   y: 0, width: 120, height: 60, styles: { ...makeElement().styles, backgroundColor: "rgb(124,58,237)" } }), // E — DOM 4, visually leftmost
      ],
    })];
    const svg = elementTreeToSvg(tree, 600, 60);
    const order = fillOrder(svg, [
      "rgb(220,38,38)", "rgb(22,163,74)", "rgb(37,99,235)", "rgb(234,88,12)", "rgb(124,58,237)",
    ]);
    expect(order).toEqual([
      "rgb(124,58,237)", // E (DOM-last) paints first under row-reverse
      "rgb(234,88,12)",  // D
      "rgb(37,99,235)",  // C
      "rgb(22,163,74)",  // B
      "rgb(220,38,38)",  // A (DOM-first, visually rightmost) paints last/top
    ]);
  });

  it("does NOT reverse paint order for flex-direction:row (default — DOM order)", () => {
    // Section 1 sanity: same items but `flex-direction: row` (default) with
    // no `order` set → paint = source/DOM order, A first, E last.
    const tree = [makeElement({
      x: 0, y: 0, width: 600, height: 60,
      styles: { ...makeElement().styles, display: "flex", flexDirection: "row", backgroundColor: "rgb(13,17,23)" },
      children: [
        makeElement({ x: 0,   y: 0, width: 120, height: 60, styles: { ...makeElement().styles, backgroundColor: "rgb(220,38,38)" } }),
        makeElement({ x: 120, y: 0, width: 120, height: 60, styles: { ...makeElement().styles, backgroundColor: "rgb(124,58,237)" } }),
      ],
    })];
    const svg = elementTreeToSvg(tree, 600, 60);
    const order = fillOrder(svg, ["rgb(220,38,38)", "rgb(124,58,237)"]);
    expect(order).toEqual(["rgb(220,38,38)", "rgb(124,58,237)"]);
  });

  it("combines `order` reordering with explicit z-index buckets (z-index wins)", () => {
    // green has order:5 (visually last) but z:1 — should paint AFTER red
    // (z:auto) regardless of order. Red is order:1 (visually first) z:auto.
    const tree = [makeElement({
      x: 0, y: 0, width: 200, height: 60,
      styles: { ...makeElement().styles, display: "flex", backgroundColor: "rgb(13,17,23)" },
      children: [
        makeElement({ x: 100, y: 0, width: 100, height: 60, styles: { ...makeElement().styles, order: "5", zIndex: "1", backgroundColor: "rgb(22,163,74)" } }), // green
        makeElement({ x: 0,   y: 0, width: 100, height: 60, styles: { ...makeElement().styles, order: "1", backgroundColor: "rgb(220,38,38)" } }), // red
      ],
    })];
    const svg = elementTreeToSvg(tree, 200, 60);
    const order = fillOrder(svg, ["rgb(220,38,38)", "rgb(22,163,74)"]);
    expect(order).toEqual([
      "rgb(220,38,38)", // red (auto bucket — paints before any explicit-z item)
      "rgb(22,163,74)", // green (z:1 — last)
    ]);
  });
});

describe("DM-543 position:fixed escapes ancestor overflow clips", () => {
  // CSS painting order: position:fixed paints in the viewport stacking
  // context and escapes ALL ancestor overflow clips — UNLESS an ancestor
  // creates a containing block for fixed (transform / filter / will-change:
  // <transform|filter|perspective> / contain: <paint|strict|content|layout>),
  // in which case the descendant is anchored to that ancestor and respects
  // its clipping.

  // The renderer wraps an overflow-clipping ancestor's children in
  // `<g clip-path="url(#ovN)">`. We verify "escaped" vs "trapped" by
  // checking whether the pin's fill appears AFTER the closing </g> of the
  // clip group (escaped) or before it (trapped).

  function clipState(svg: string, pinFill: string): "escaped" | "trapped" | "missing" {
    const pinIdx = svg.indexOf(`fill="${pinFill}"`);
    if (pinIdx < 0) return "missing";
    // Walk all <g.../</g> tokens up to pinIdx, tracking the open-tag stack.
    // The pin is "trapped" if any frame on the stack at pinIdx is a
    // clip-path group; "escaped" otherwise.
    const tokens = svg.slice(0, pinIdx).matchAll(/<g\b[^>]*>|<\/g>/g);
    const stack: string[] = [];
    for (const t of tokens) {
      const s = t[0];
      if (s === "</g>") stack.pop();
      else stack.push(s);
    }
    return stack.some((s) => s.includes('clip-path="url(#ov')) ? "trapped" : "escaped";
  }

  it("hoists position:fixed inside an overflow:auto SC ancestor to the root SC", () => {
    // Tree:
    //   section (overflow:auto SC, NOT a fixed CB)
    //     innerDiv (static, no CB)
    //       pin (position:fixed)  ← should escape section's clip-path group
    const tree = [makeElement({
      x: 0, y: 0, width: 300, height: 100,
      styles: { ...makeElement().styles, backgroundColor: "rgb(248,250,252)", overflowX: "auto", overflowY: "auto" },
      children: [
        makeElement({
          x: 0, y: 0, width: 300, height: 200,
          styles: { ...makeElement().styles, backgroundColor: "rgb(241,245,249)" },
          children: [
            makeElement({
              x: 250, y: 80, width: 40, height: 16,
              styles: { ...makeElement().styles, position: "fixed", backgroundColor: "rgb(220,38,38)" },
            }),
          ],
        }),
      ],
    })];
    const svg = elementTreeToSvg(tree, 300, 100);
    expect(clipState(svg, "rgb(220,38,38)")).toBe("escaped");
  });

  it("traps position:fixed inside a transform-CB ancestor (does not over-escape)", () => {
    // Tree:
    //   section (overflow:auto SC, NOT a fixed CB)
    //     frame (transform:translate(0) — IS a fixed CB)
    //       pin (position:fixed)  ← stays trapped under frame inside section's clip
    const tree = [makeElement({
      x: 0, y: 0, width: 300, height: 100,
      styles: { ...makeElement().styles, backgroundColor: "rgb(248,250,252)", overflowX: "auto", overflowY: "auto" },
      children: [
        makeElement({
          x: 0, y: 0, width: 300, height: 200,
          styles: { ...makeElement().styles, position: "relative", transform: "matrix(1, 0, 0, 1, 0, 0)", backgroundColor: "rgb(254,243,199)" },
          children: [
            makeElement({
              x: 250, y: 180, width: 40, height: 16,
              styles: { ...makeElement().styles, position: "fixed", backgroundColor: "rgb(220,38,38)" },
            }),
          ],
        }),
      ],
    })];
    const svg = elementTreeToSvg(tree, 300, 100);
    expect(clipState(svg, "rgb(220,38,38)")).toBe("trapped");
  });

  it("traps position:fixed inside a contain:paint ancestor", () => {
    const tree = [makeElement({
      x: 0, y: 0, width: 300, height: 100,
      styles: { ...makeElement().styles, backgroundColor: "rgb(248,250,252)", overflowX: "auto", overflowY: "auto" },
      children: [
        makeElement({
          x: 0, y: 0, width: 300, height: 200,
          styles: { ...makeElement().styles, position: "relative", contain: "paint", backgroundColor: "rgb(254,243,199)" },
          children: [
            makeElement({
              x: 250, y: 180, width: 40, height: 16,
              styles: { ...makeElement().styles, position: "fixed", backgroundColor: "rgb(220,38,38)" },
            }),
          ],
        }),
      ],
    })];
    const svg = elementTreeToSvg(tree, 300, 100);
    expect(clipState(svg, "rgb(220,38,38)")).toBe("trapped");
  });

  it("traps position:fixed inside a will-change:transform ancestor", () => {
    const tree = [makeElement({
      x: 0, y: 0, width: 300, height: 100,
      styles: { ...makeElement().styles, backgroundColor: "rgb(248,250,252)", overflowX: "auto", overflowY: "auto" },
      children: [
        makeElement({
          x: 0, y: 0, width: 300, height: 200,
          styles: { ...makeElement().styles, position: "relative", willChange: "transform", backgroundColor: "rgb(254,243,199)" },
          children: [
            makeElement({
              x: 250, y: 180, width: 40, height: 16,
              styles: { ...makeElement().styles, position: "fixed", backgroundColor: "rgb(220,38,38)" },
            }),
          ],
        }),
      ],
    })];
    const svg = elementTreeToSvg(tree, 300, 100);
    expect(clipState(svg, "rgb(220,38,38)")).toBe("trapped");
  });

  it("hoists position:fixed past nested non-CB SC ancestors (overflow scroller inside overflow scroller)", () => {
    // section1 (overflow:auto) > section2 (overflow:auto) > pin (fixed)
    // Both scrollers are SCs but neither is a fixed-CB; pin escapes to root.
    const tree = [makeElement({
      x: 0, y: 0, width: 300, height: 100,
      styles: { ...makeElement().styles, backgroundColor: "rgb(248,250,252)", overflowX: "auto", overflowY: "auto" },
      children: [
        makeElement({
          x: 0, y: 0, width: 300, height: 200,
          styles: { ...makeElement().styles, backgroundColor: "rgb(241,245,249)", overflowX: "auto", overflowY: "auto" },
          children: [
            makeElement({
              x: 250, y: 80, width: 40, height: 16,
              styles: { ...makeElement().styles, position: "fixed", backgroundColor: "rgb(220,38,38)" },
            }),
          ],
        }),
      ],
    })];
    const svg = elementTreeToSvg(tree, 300, 100);
    expect(clipState(svg, "rgb(220,38,38)")).toBe("escaped");
  });
});
