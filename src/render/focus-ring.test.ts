import { describe, expect, it } from "vitest";
import type { FocusRingFacts } from "../capture/script/walker/focus-ring.js";
import { capturedElement } from "../test-support/captured-fixtures.js";
import {
  cornerRoundedContourPath,
  focusRingStrokes,
  paintOutline,
  rectUnionBoundary,
  shrinkRightAngleContours,
} from "./outline-paint.js";

// DM-ZVQJYP: `outline-style: auto` paints Blink's two-ring focus ring
// (PaintFocusRing, outline_painter.cc:853-893, chromium 6b5a1b80).
const ring = (overrides: Partial<FocusRingFacts> = {}): FocusRingFacts => ({
  ringWidth: 3,
  ringOffset: 0,
  outlineOffset: 0,
  outerColor: "rgb(255, 255, 255)",
  innerColor: "rgb(255, 0, 0)",
  nativeAppearance: false,
  ...overrides,
});

function focused(focusRing: FocusRingFacts, styles: Record<string, string> = {}, size = 20) {
  return capturedElement({
    tag: "div",
    x: 20,
    y: 20,
    width: size,
    height: size,
    styles: { outlineStyle: "auto", outlineWidth: "0px", outlineColor: "rgb(255, 0, 0)", focusRing, ...styles },
  });
}

describe("focusRingStrokes", () => {
  it("strokes the outer ring one ring-third outside the inner ring, outer first", () => {
    const [outer, inner] = focusRingStrokes(focused(ring()));
    expect(outer).toMatchObject({ x: 19, y: 19, w: 22, h: 22, strokeWidth: 2, color: "rgb(255, 255, 255)" });
    expect(inner).toMatchObject({ x: 20, y: 20, w: 20, h: 20, strokeWidth: 2, color: "rgb(255, 0, 0)" });
    expect(inner.radii.tl).toEqual({ h: 3, v: 3 });
  });

  it("scales the ring width and offset from the captured facts", () => {
    const [outer, inner] = focusRingStrokes(focused(ring({ ringWidth: 6, ringOffset: 2 })));
    expect(inner).toMatchObject({ x: 18, y: 18, w: 24, strokeWidth: 4 });
    expect(outer).toMatchObject({ x: 16, y: 16, w: 28 });
    expect(outer.radii.br).toEqual({ h: 6, v: 6 });
  });

  it("clamps a negative ring offset per axis and skips a ring whose region collapses", () => {
    const strokes = focusRingStrokes(focused(ring({ ringOffset: -20 })));
    // Inner: -20 clamps to -10, an empty region. Outer: -19 clamps to -10 too.
    expect(strokes).toEqual([]);
    const [outer, inner] = focusRingStrokes(focused(ring({ ringOffset: -9 })));
    expect(inner).toMatchObject({ x: 29, y: 29, w: 2, h: 2 });
    expect(outer).toMatchObject({ x: 28, y: 28, w: 4, h: 4 });
  });

  it("grows authored radii by outline-offset and raises every component to the ring width", () => {
    const el = focused(ring({ outlineOffset: 3, ringOffset: 2 }), {
      borderTopLeftRadius: "6px",
      borderTopRightRadius: "1px",
    });
    const [, inner] = focusRingStrokes(el);
    expect(inner.radii.tl).toEqual({ h: 9, v: 9 });
    expect(inner.radii.tr).toEqual({ h: 4, v: 4 });
    expect(inner.radii.br).toEqual({ h: 3, v: 3 });
  });

  it("scales oversized radii down proportionally like SkRRect", () => {
    const [, inner] = focusRingStrokes(focused(ring(), {}, 4));
    expect(inner.radii.tl).toEqual({ h: 2, v: 2 });
  });

  it("paints nothing for an empty box", () => {
    expect(focusRingStrokes(focused(ring(), {}, 0))).toEqual([]);
  });
});

describe("paintOutline auto", () => {
  it("paints both rings even when outline-width is zero", () => {
    const markup = paintOutline(focused(ring()), 0, "");
    expect(markup).toHaveLength(2);
    expect(markup[0]).toContain('stroke="rgb(255,255,255)" stroke-width="2"');
    expect(markup[1]).toContain('stroke="rgb(255,0,0)"');
  });

  it("drops only a transparent ring", () => {
    const markup = paintOutline(focused(ring({ innerColor: "rgba(0, 0, 0, 0)" })), 0, "");
    expect(markup).toHaveLength(1);
    expect(markup[0]).toContain('stroke="rgb(255,255,255)"');
  });
});

describe("multi-fragment focus rings (DM-7NN5E6)", () => {
  it("traces the union of line rects as one clockwise contour without collinear vertices", () => {
    // Two stacked lines: the first starts at x=20, the second ends at x=40.
    const contours = rectUnionBoundary([
      { left: 20, top: 0, right: 60, bottom: 20 },
      { left: 0, top: 20, right: 40, bottom: 40 },
    ]);
    expect(contours).toHaveLength(1);
    expect(contours[0]).toHaveLength(8);
    expect(contours[0]).toContainEqual([20, 0]);
    expect(contours[0]).toContainEqual([60, 20]);
    expect(contours[0]).toContainEqual([40, 40]);
    expect(contours[0]).toContainEqual([0, 20]);
  });

  it("returns a single rect contour for overlapping rects that cover a rectangle", () => {
    const contours = rectUnionBoundary([
      { left: 0, top: 0, right: 40, bottom: 20 },
      { left: 0, top: 10, right: 40, bottom: 30 },
    ]);
    expect(contours).toEqual([
      [
        [0, 0],
        [40, 0],
        [40, 30],
        [0, 30],
      ],
    ]);
  });

  it("rounds corners like SkCornerPathEffect, halving the step on short segments", () => {
    const path = cornerRoundedContourPath(
      [
        [
          [0, 0],
          [20, 0],
          [20, 4],
          [0, 4],
        ],
      ],
      3,
    );
    expect(path.startsWith("M3,0 L17,0 Q20,0 20,2")).toBe(true);
    // The 4px side is shorter than 2·radius: no straight part, steps of 2.
    expect(path).toContain("Q20,4 17,4");
    expect(path.endsWith("Q0,0 3,0 Z")).toBe(true);
  });

  it("strokes a wrapped inline ring as one corner-rounded region path", () => {
    const el = focused(ring());
    el.inlineFragments = [
      { x: 30, y: 20, width: 30, height: 20 },
      { x: 10, y: 40, width: 30, height: 20 },
    ] as typeof el.inlineFragments;
    const [outer, inner] = focusRingStrokes(el);
    expect(inner.path).toMatch(/^M33,20 /);
    expect(outer.path).toMatch(/^M32,19 /);
    expect(paintOutline(el, 0, "").every((markup) => markup.includes(' d="M') && !markup.includes(" A"))).toBe(true);
  });
});

describe("wrapped inline normal outlines (DM-9JNAVF)", () => {
  it("shrinks a right-angle contour inward by the width (ShrinkCorner)", () => {
    const outer = rectUnionBoundary([
      { left: 20, top: 0, right: 60, bottom: 20 },
      { left: 0, top: 20, right: 40, bottom: 40 },
    ]);
    const inner = shrinkRightAngleContours(outer, 2)[0];
    expect(inner).toContainEqual([22, 2]);
    expect(inner).toContainEqual([58, 18]);
    expect(inner).toContainEqual([38, 38]);
    expect(inner).toContainEqual([2, 22]);
    // Concave corners move outward from the region's notch.
    expect(inner).toContainEqual([22, 22]);
    expect(inner).toContainEqual([38, 18]);
  });

  const wrapped = (style: string, width: string) => {
    const el = capturedElement({
      tag: "span",
      x: 10,
      y: 0,
      width: 50,
      height: 40,
      styles: { outlineStyle: style, outlineWidth: width, outlineColor: "rgb(255, 0, 0)", outlineOffset: "0px" },
    });
    el.inlineFragments = [
      { x: 30, y: 0, width: 30, height: 20 },
      { x: 10, y: 20, width: 30, height: 20 },
    ] as typeof el.inlineFragments;
    return paintOutline(el, 0, "");
  };

  it("fills a solid outline as one even-odd ring around the fragment union", () => {
    const markup = wrapped("solid", "2px");
    expect(markup).toHaveLength(1);
    expect(markup[0]).toContain('fill-rule="evenodd"');
    expect(markup[0]).toContain("M28,-2");
  });

  it("fills a double outline as two stripes, and treats width <= 2 as solid", () => {
    expect(wrapped("double", "6px")).toHaveLength(2);
    expect(wrapped("double", "2px")).toHaveLength(1);
  });

  // DM-EQ1MPF: dashed/dotted stroke each center-path edge alone inside the ring.
  it("strokes each center edge of a dashed outline inside the fragment ring", () => {
    const markup = wrapped("dashed", "2px").join("\n");
    expect(markup).toMatch(
      /<clipPath id="outline-frag-[a-z0-9]+"><path d="M28,-2 [^"]*" clip-rule="evenodd" \/><\/clipPath>/,
    );
    // Eight edges of the two-line union, each extended by ceil(width / 2).
    expect(markup.match(/<line /g)).toHaveLength(8);
    expect(markup).toContain('<line x1="28" y1="-1" x2="62" y2="-1"');
  });

  it("strokes an odd dashed width 2px wider and shifts it half a pixel", () => {
    expect(wrapped("dashed", "3px").join("\n")).toContain('stroke-width="5"');
  });

  it("leaves 3D outlines on the single-rect path", () => {
    expect(wrapped("groove", "4px").join("\n")).not.toContain("outline-frag-");
  });
});
