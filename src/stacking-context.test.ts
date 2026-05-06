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
