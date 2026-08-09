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

/** Ctx spanning x ∈ [0, 100] whose computeGapsAt returns `gaps` and whose
 *  subSegments splits the span around them (the real renderTextDecoration
 *  shape), recording the (yRel, thick, pad) computeGapsAt was asked for. */
function gapCtx(style: string | undefined, gaps: Array<[number, number]>): DecorationLineCtx & { asked: Array<{ yRel: number; thick: number; pad: number }> } {
  const asked: Array<{ yRel: number; thick: number; pad: number }> = [];
  return {
    style,
    runBaselineY: 0,
    segX: 0,
    decorationColor: "#f00",
    asked,
    computeGapsAt: (yRel, thick, pad) => { asked.push({ yRel, thick, pad }); return gaps; },
    subSegments: (g) => {
      const out: Array<{ x0: number; x1: number }> = [];
      let cursor = 0;
      for (const [a, b] of g) {
        if (a > cursor) out.push({ x0: cursor, x1: Math.min(a, 100) });
        cursor = Math.max(cursor, b);
      }
      if (cursor < 100) out.push({ x0: cursor, x1: 100 });
      return out;
    },
  };
}

describe("emitDecorationLine: dashed/dotted skip-ink — ONE dash pattern across gaps (TextPainter::ClipDecorationLine + PaintDecorationLine, text_decoration_painter.cc:180-207)", () => {
  it("a dashed underline crossing a descender keeps ONE dasharray computed over the full span, with the gaps clipped out of it", () => {
    // t 3 (ti 3): ideal dash 6 gap 3; full span 100 fits gap 3.4
    // (SelectBestDashGap). The gap [40,60] must NOT re-fit the pattern per
    // surviving sub-segment (the old split emit turned this into two lines
    // reading "6 2.5" for the 40px left piece) — Blink strokes the full span
    // through the clip, so the phase is continuous across the gap.
    const out = emitDecorationLine(20, 3, "underline", true, gapCtx("dashed", [[40, 60]]));
    expect(attr(out, "stroke-dasharray")).toEqual(["6 3.4"]);
    expect([...out.matchAll(/<line /g)]).toHaveLength(1);
    // The gap is carried by a clip path over the surviving sub-segments.
    expect([...out.matchAll(/<clipPath /g)]).toHaveLength(1);
    expect([...out.matchAll(/<rect [^>]*width="([^"]+)"/g)].map((m) => m[1])).toEqual(["40", "40"]); // [0,40] and [60,100]
    expect(out).toContain("clip-path=\"url(#");
  });

  it("dashed and dotted are no longer excluded from skip-ink — computeGapsAt IS consulted, with Bounds' snapped rounded-thickness band and the unrounded dilation", () => {
    // Blink's dispatch reads only TextDecorationSkipInk(), never the style;
    // the intercept band for dashed/dotted is DecorationLinePainter::Bounds —
    // midline floor(top + max(t/2, 0.5)) ± roundf(t)/2
    // (decoration_line_painter.cc:409-417) — while the dilation stays
    // min(unrounded t, 13) (text_painter.cc:607-608).
    const ctx1 = gapCtx("dashed", []);
    emitDecorationLine(20, 3.4, "underline", true, ctx1);
    expect(ctx1.asked).toEqual([{ yRel: Math.floor(20 + 1.7), thick: 3, pad: 3.4 }]);
    const ctx2 = gapCtx("dotted", []);
    emitDecorationLine(20, 3.4, "underline", true, ctx2);
    expect(ctx2.asked).toHaveLength(1);
  });

  it("line-through dashed still never skips ink", () => {
    const ctx1 = gapCtx("dashed", [[40, 60]]);
    const out = emitDecorationLine(20, 3, "line-through", false, ctx1);
    expect(ctx1.asked).toHaveLength(0);
    expect([...out.matchAll(/<clipPath /g)]).toHaveLength(0);
  });

  it("endpoints truncate to integers (GetSnappedPointsForTextLine returns int gfx::Point) and the dash fit uses the integer span", () => {
    const ctx1 = gapCtx("dashed", []);
    ctx1.subSegments = () => [{ x0: 0.7, x1: 100.6 }];
    const out = emitDecorationLine(20, 3, "underline", true, ctx1);
    expect(attr(out, "x1")).toEqual(["0"]);
    expect(attr(out, "x2")).toEqual(["100"]);
    expect(attr(out, "stroke-dasharray")).toEqual(["6 3.4"]); // fit over 100, not 99.9
  });

  it("no gaps → a bare line, no clip path", () => {
    const out = emitDecorationLine(20, 3, "underline", true, gapCtx("dashed", []));
    expect([...out.matchAll(/<clipPath /g)]).toHaveLength(0);
    expect([...out.matchAll(/<line /g)]).toHaveLength(1);
  });
});

describe("emitDecorationLine: skip-ink dilation is the LINE thickness for every style (kDecorationClipMaxDilation, text_painter.cc:46,607-608)", () => {
  it("double: the band spans both bars but the pad stays min(t, 13)", () => {
    const ctx1 = gapCtx("double", []);
    emitDecorationLine(20, 3, "underline", true, ctx1);
    expect(ctx1.asked).toHaveLength(1);
    expect(ctx1.asked[0].thick).toBe(3 + 4); // t + |t+1|
    expect(ctx1.asked[0].pad).toBe(3);
  });

  it("wavy: the band is the pattern rect but the pad stays min(t, 13)", () => {
    const ctx1 = gapCtx("wavy", []);
    emitDecorationLine(20, 2, "underline", true, ctx1);
    expect(ctx1.asked).toHaveLength(1);
    expect(ctx1.asked[0].pad).toBe(2);
  });
});

describe("emitDecorationLine: wavy pattern rect (ComputeWavyPatternRect, decoration_line_painter.cc:200-212; Path::StrokeBoundingRect = tight bounds of the Skia-stroked outline)", () => {
  it("band = floor/ceil of centerline 0.5 ± (cpDist/(2√3) + t/2), emitted as the clip rect", () => {
    // t 2: wavelength 11, cpDist 7.5, amp = 7.5/(2√3) ≈ 2.1651.
    // floor(0.5 − 3.1651) = −3, ceil(0.5 + 3.1651) = 4 → band top
    // yTop + (t+1) − 3 = 20, height 7.
    const out = emitDecorationLine(20, 2, "underline", false, ctx("wavy"));
    const rect = /<rect x="0" y="([^"]+)" width="100" height="([^"]+)"/.exec(out);
    expect(rect).not.toBeNull();
    expect(rect![1]).toBe("20");
    expect(rect![2]).toBe("7");
  });

  it("skip-ink gaps clip ONE continuous wave — the phase does not restart after a gap", () => {
    // Gap [40,60]: one <path> anchored at segX with cubics on the wavelength
    // grid (the tile shader's phase), two clip rects. The old emit produced
    // one path per sub-segment with the second re-anchored mid-grid.
    const out = emitDecorationLine(20, 2, "underline", true, gapCtx("wavy", [[40, 60]]));
    expect([...out.matchAll(/<path /g)]).toHaveLength(1);
    expect(out).toContain("M 0 23.5");
    // Every cubic endpoint sits on the k·wavelength grid (λ = 11).
    const ends = [...out.matchAll(/ C [^ ]+ [^ ]+ [^ ]+ [^ ]+ ([^ ]+) 23.5/g)].map((m) => parseFloat(m[1]));
    expect(ends.length).toBeGreaterThan(0);
    for (const e of ends) expect(e % 11).toBeCloseTo(0, 6);
    expect([...out.matchAll(/<rect /g)]).toHaveLength(2);
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
