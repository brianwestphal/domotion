// Paint-time decoration-line snapping, transcribed from Chromium's
// `core/paint/decoration_line_painter.cc` (rev 7d859f27): SnapYAxis /
// RoundDownThickness for solid and double, GetSnappedPointsForTextLine (+ the
// odd-integer-thickness half-pixel shift of DrawLineAsStroke) for dashed and
// dotted, and the unsnapped `PathOrigin + 0.5` centerline for wavy. The
// second bar of a double line offsets by ±(t+1) / floor(t+1)
// (`text_decoration_info.cc:259-284`) and snaps independently.
import { describe, expect, it } from "vitest";

import { emitDecorationLine, type DecorationLineCtx } from "./text.js";

/** Ctx with skip-ink disabled (no gaps) spanning x ∈ [0, 100]. */
function ctx(style: string | undefined): DecorationLineCtx {
  return {
    style,
    runBaselineY: 0,
    segX: 0,
    decorationColor: "#f00",
    computeGapsAt: () => [],
    subSegments: () => [{ x0: 0, x1: 100 }],
  };
}

function attr(markup: string, name: string): string[] {
  return [...markup.matchAll(new RegExp(`${name}="([^"]+)"`, "g"))].map((m) => m[1]);
}

describe("emitDecorationLine: solid snap (SnapYAxis, decoration_line_painter.cc:40-45,104-124)", () => {
  it("rect top floor(y + 0.5), height max(floor(t), 1), emitted as a centered stroke", () => {
    // yTop 20.4, t 1.6: snapped top floor(20.9) = 20, height 1 → line y 20.5.
    const out = emitDecorationLine(20.4, 1.6, "underline", true, ctx("solid"));
    expect(attr(out, "y1")).toEqual(["20.5"]);
    expect(attr(out, "stroke-width")).toEqual(["1"]);
  });

  it("half-up rounding of the rect top", () => {
    // yTop 20.6: floor(21.1) = 21 → line y 21.5.
    const out = emitDecorationLine(20.6, 1.6, "underline", true, ctx("solid"));
    expect(attr(out, "y1")).toEqual(["21.5"]);
  });

  it("thick line: height floor(t) — 3.25 paints 3", () => {
    // yTop 30, t 3.25: top 30, height 3 → y 31.5.
    const out = emitDecorationLine(30, 3.25, "underline", true, ctx("solid"));
    expect(attr(out, "y1")).toEqual(["31.5"]);
    expect(attr(out, "stroke-width")).toEqual(["3"]);
  });
});

describe("emitDecorationLine: double bars (text_decoration_info.cc:259-284; independent SnapYAxis)", () => {
  it("underline: second bar t+1 BELOW the first", () => {
    // yTop 20, t 3: bars at 20 and 20 + 4 = 24, height 3 → y 21.5 / 25.5.
    const out = emitDecorationLine(20, 3, "underline", true, ctx("double"));
    expect(attr(out, "y1")).toEqual(["21.5", "25.5"]);
    expect(attr(out, "stroke-width")).toEqual(["3", "3"]);
  });

  it("overline: second bar t+1 ABOVE the first", () => {
    // yTop 20, t 3: bars at 20 and 20 − 4 = 16 → y 21.5 / 17.5.
    const out = emitDecorationLine(20, 3, "overline", true, ctx("double"));
    expect(attr(out, "y1")).toEqual(["21.5", "17.5"]);
  });

  it("line-through: second bar offset floor(t+1) below", () => {
    // t 2.4 → floor(3.4) = 3: bars at 20 and 23, height 2 → y 21 / 24.
    const out = emitDecorationLine(20, 2.4, "line-through", false, ctx("double"));
    expect(attr(out, "y1")).toEqual(["21", "24"]);
    expect(attr(out, "stroke-width")).toEqual(["2", "2"]);
  });

  it("each bar snaps independently (fractional t and offset)", () => {
    // yTop 20.3, t 1.6, offset 2.6: tops floor(20.8) = 20 and
    // floor(22.9 + 0.5) = 23, height 1 → y 20.5 / 23.5.
    const out = emitDecorationLine(20.3, 1.6, "underline", true, ctx("double"));
    expect(attr(out, "y1")).toEqual(["20.5", "23.5"]);
  });
});

describe("emitDecorationLine: dashed/dotted midpoint snap (decoration_line_painter.cc:47-53,71-76)", () => {
  it("midY = floor(top + max(t/2, 0.5)); even roundf(t) keeps integer y; stroke width stays unsnapped", () => {
    // yTop 20.2, t 2: floor(21.2) = 21, roundf(2) even → y 21.
    const out = emitDecorationLine(20.2, 2, "underline", false, ctx("dashed"));
    expect(attr(out, "y1")).toEqual(["21"]);
    expect(attr(out, "stroke-width")).toEqual(["2"]);
  });

  it("odd roundf(t) shifts the line down 0.5 to align with the pixel grid", () => {
    // yTop 20, t 3: floor(21.5) = 21, roundf(3) odd → y 21.5.
    const out = emitDecorationLine(20, 3, "underline", false, ctx("dotted"));
    expect(attr(out, "y1")).toEqual(["21.5"]);
    // Unsnapped stroke width even when the dash geometry rounds.
    const thin = emitDecorationLine(20, 1.6, "underline", false, ctx("dashed"));
    expect(attr(thin, "stroke-width")).toEqual(["1.6"]);
  });
});

describe("emitDecorationLine: wavy centerline (WavyGeometry::PathOrigin + PaintRibbon, decoration_line_painter.cc:298-304,334-337)", () => {
  it("centerline sits at yTop + (t+1) + 0.5 for underline, stroked at the resolved thickness", () => {
    // yTop 20, t 2: centerline y 23.5; the cubic's endpoints sit ON the
    // centerline (M x y with y = 23.5), stroke-width 2.
    const out = emitDecorationLine(20, 2, "underline", false, ctx("wavy"));
    expect(out).toContain("M 0 23.5");
    expect(attr(out, "stroke-width")).toEqual(["2"]);
  });

  it("overline wave offsets −(t+1); line-through wave offsets 0", () => {
    const over = emitDecorationLine(20, 2, "overline", false, ctx("wavy"));
    expect(over).toContain("M 0 17.5"); // 20 − 3 + 0.5
    const through = emitDecorationLine(20, 2, "line-through", false, ctx("wavy"));
    expect(through).toContain("M 0 20.5"); // 20 + 0 + 0.5
  });
});
