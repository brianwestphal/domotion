import { describe, expect, it } from "vitest";
import {
  buildCases,
  compareBars,
  compareSegments,
  decorationCorpusSha256,
  decorationOracleScalePlan,
  decorationOracleScalePlanErrors,
  expandDashSegments,
  lengthPx,
  parseSvgDecorations,
  predictCase,
  svgBarsInWindow,
  type CaseSpec,
  type PageMeasure,
} from "../tools/decoration-oracle.js";

describe("DM-2501 decoration coordinate ownership", () => {
  it("binds Chrome paint and Domotion capture to one device scale", () => {
    expect(decorationOracleScalePlan()).toEqual({ chromePaint: 4, domotionCapture: 4 });
    expect(decorationOracleScalePlan(2)).toEqual({ chromePaint: 2, domotionCapture: 2 });
    expect(decorationOracleScalePlanErrors(decorationOracleScalePlan())).toEqual([]);
  });

  it("rejects the cross-DPR comparison that produced the arm64 +1 CSS-px false failure", () => {
    expect(decorationOracleScalePlanErrors({ chromePaint: 4, domotionCapture: 1 })).toEqual([
      "cross-DPR decoration geometry comparison is invalid: Chrome=4, capture=1",
    ]);
    expect(() => decorationOracleScalePlan(0)).toThrow(/finite and positive/);
  });

  it("keeps the 0.3px geometry envelope strict against a one-pixel origin mutation", () => {
    const expected = [{ top: 134, height: 1 }];
    expect(compareBars(expected, [{ top: 134, height: 1, x0: 0, x1: 10, segments: [] }], 0.3, "rule", "svg").ok).toBe(true);
    expect(compareBars(expected, [{ top: 135, height: 1, x0: 0, x1: 10, segments: [] }], 0.3, "rule", "svg").ok).toBe(false);
  });
});

// Hand-computed expectations against the transcribed Blink rules
// (Chromium rev 7d859f27): thickness `core/paint/text_decoration_info.cc:65-92`
// + max(1,t) at :449-451; underline offset `core/layout/text_decoration_offset.cc:16-35`;
// line-through `text_decoration_info.cc:385-386`; paint snap
// `core/paint/decoration_line_painter.cc` SnapYAxis/RoundDownThickness.
const meas = (ascF: number, effectiveFontSize = 24): PageMeasure => ({
  rect: { x: 10, y: 100, w: 200, h: 28 },
  baselineY: 100 + ascF,
  ascF,
  descF: 6,
  fragments: 1,
  effectiveFontSize,
});

const base: Omit<CaseSpec, "id"> & { id: string } = {
  id: "t", family: "NoSuchFontFamily", fontSize: 24, lines: "underline", style: "solid",
};

describe("lengthPx", () => {
  it("resolves px, em, and percent against font size", () => {
    expect(lengthPx("5px", 24)).toBe(5);
    expect(lengthPx("0.2em", 24)).toBeCloseTo(4.8);
    expect(lengthPx("25%", 24)).toBe(6);
    expect(lengthPx("-2px", 24)).toBe(-2);
    expect(lengthPx("auto", 24)).toBeNull();
    expect(lengthPx("3px", 30, 1.25)).toBe(3.75);
  });
});

describe("decoration corpus identity", () => {
  it("includes zoom activation rows in the deterministic fingerprint", () => {
    const cases = buildCases();
    expect(cases.filter((row) => row.zoom != null).map((row) => row.zoom)).toEqual([0.8, 1.25, 2]);
    expect(decorationCorpusSha256(cases)).toMatch(/^[0-9a-f]{64}$/);
    expect(decorationCorpusSha256(cases)).toBe(decorationCorpusSha256(cases));
  });
});

describe("predictCase — Blink rule algebra", () => {
  it("underline auto/auto: top = ascI + max(1, ceil(t/2)), h = floor(t)", () => {
    // fs 24 -> t = 2.4, gap = ceil(1.2) = 2, topRel = 22 + 2 = 24.
    const p = predictCase({ ...base }, meas(22));
    expect(p.bars).toEqual([{ top: 124, height: 2 }]);
    expect(p.thickness).toBeCloseTo(2.4);
  });
  it("explicit thickness participates in the auto gap", () => {
    // t = 5 -> gap = ceil(2.5) = 3 -> topRel 25.
    const p = predictCase({ ...base, thickness: "5px" }, meas(22));
    expect(p.bars).toEqual([{ top: 125, height: 5 }]);
  });
  it("applies CSS zoom to used size and absolute decoration lengths", () => {
    const p = predictCase({ ...base, thickness: "3px", underlineOffset: "2px", zoom: 1.25 }, {
      ...meas(27.5, 30), rect: { x: 10, y: 100, w: 250, h: 35 },
    });
    expect(p.thickness).toBe(4);
    expect(p.bars).toEqual([{ top: 131, height: 4 }]);
  });
  it("percent thickness is rounded then floored at paint", () => {
    // 10% of 24 = 2.4 -> roundf = 2 -> gap = 1 -> topRel 23, h 2.
    const p = predictCase({ ...base, thickness: "10%" }, meas(22));
    expect(p.bars).toEqual([{ top: 123, height: 2 }]);
  });
  it("a length text-underline-offset zeroes the auto gap", () => {
    const p = predictCase({ ...base, underlineOffset: "4px" }, meas(22));
    expect(p.bars).toEqual([{ top: 126, height: 2 }]); // 22 + 0 + 4
  });
  it("negative offsets lift the bar", () => {
    const p = predictCase({ ...base, underlineOffset: "-2px" }, meas(22));
    expect(p.bars).toEqual([{ top: 120, height: 2 }]);
  });
  it("line-through: 2*ascF/3 - t/2, then snapped", () => {
    // 44/3 - 1.2 = 13.4667 -> floor(+0.5) = 13.
    const p = predictCase({ ...base, lines: "line-through" }, meas(22));
    expect(p.bars).toEqual([{ top: 113, height: 2 }]);
  });
  it("overline: floor(LU(ascF - ascI)) - floor(t)", () => {
    const p = predictCase({ ...base, lines: "overline" }, meas(22));
    expect(p.bars).toEqual([{ top: 98, height: 2 }]);
    // ascF just below its rounded ascI (21.6 -> ascI 22) floors LU(-0.4) to -1.
    const p2 = predictCase({ ...base, lines: "overline" }, meas(21.6));
    expect(p2.bars).toEqual([{ top: 100 - 1 - 2, height: 2 }]);
  });
  it("double: second bar at +(t+1), snapped independently", () => {
    const p = predictCase({ ...base, style: "double" }, meas(22));
    expect(p.bars).toEqual([{ top: 124, height: 2 }, { top: 127, height: 2 }]);
  });
  it("dashed/dotted: stroke band at the snapped midline with the UNROUNDED width", () => {
    // fs 24 -> t 2.4, auto gap 2 -> topRel 24; midY = floor(24 + 1.2) = 25,
    // roundf(2.4) = 2 even -> no half shift; band = 25 ± 1.2.
    const p = predictCase({ ...base, style: "dashed" }, meas(22));
    expect(p.bars).toHaveLength(1);
    expect(p.bars[0].top).toBeCloseTo(100 + 25 - 1.2, 6);
    expect(p.bars[0].height).toBeCloseTo(2.4, 6);
    // Odd rounded thickness shifts the midline down 0.5.
    const p5 = predictCase({ ...base, style: "dotted", thickness: "5px" }, meas(22));
    expect(p5.bars[0].top).toBeCloseTo(100 + Math.floor(25 + 2.5) + 0.5 - 2.5, 6);
    expect(p5.bars[0].height).toBe(5);
  });
  it("wavy: ink extent = centerline ± (cpDist/(2√3) + t/2)", () => {
    // fs 24 -> t 2.4: cpDist = 0.5 + round(3·2.4 + 0.5) = 8.5,
    // amp = 8.5/(2√3); centerline at topRel 24 + (t+1) + 0.5.
    const p = predictCase({ ...base, style: "wavy" }, meas(22));
    const amp = 8.5 / (2 * Math.sqrt(3));
    expect(p.bars).toHaveLength(1);
    expect(p.bars[0].top).toBeCloseTo(100 + 24 + 3.4 + 0.5 - (amp + 1.2), 6);
    expect(p.bars[0].height).toBeCloseTo(2 * amp + 2.4, 6);
  });
  it("thickness never predicts below 1px", () => {
    const p = predictCase({ ...base, fontSize: 8 }, { ...meas(8, 8), rect: { x: 10, y: 100, w: 80, h: 10 } });
    expect(p.bars[0].height).toBe(1); // t = max(1, 0.8) = 1
  });
});

describe("parseSvgDecorations", () => {
  it("accumulates translate transforms and keeps only red horizontal lines", () => {
    const svg = `
      <g transform="translate(5, 40)">
        <line x1="0" y1="10" x2="100" y2="10" stroke="#ff0000" stroke-width="2"/>
        <g transform="translate(0, 100)">
          <line x1="10" y1="1" x2="90" y2="1" stroke="rgb(255, 0, 0)" stroke-width="3"/>
        </g>
        <line x1="0" y1="20" x2="100" y2="20" stroke="#00ff00" stroke-width="2"/>
        <line x1="0" y1="30" x2="100" y2="35" stroke="#ff0000" stroke-width="2"/>
      </g>`;
    const { lines } = parseSvgDecorations(svg);
    expect(lines).toMatchObject([
      { kind: "line", y: 50, w: 2, x0: 5, x1: 105 },
      { kind: "line", y: 141, w: 3, x0: 15, x1: 95 },
    ]);
  });
  it("groups same-y lines into one bar with segments (skip-ink sub-segments)", () => {
    const svg = `
      <line x1="0" y1="50" x2="40" y2="50" stroke="red" stroke-width="2"/>
      <line x1="60" y1="50" x2="100" y2="50" stroke="red" stroke-width="2"/>`;
    const bars = svgBarsInWindow(parseSvgDecorations(svg), { top: 0, bottom: 100 });
    expect(bars).toHaveLength(1);
    expect(bars[0]).toMatchObject({ top: 49, height: 2 });
    expect(bars[0].segments).toEqual([{ x0: 0, x1: 40 }, { x0: 60, x1: 100 }]);
  });
  it("parses clipPath rects and attaches element- and group-level clip-path references", () => {
    const svg = `
      <clipPath id="a"><rect x="0" y="18" width="40" height="6"/><rect x="60" y="18" width="40" height="6"/></clipPath>
      <g clip-path="url(#a)"><line x1="0" y1="21" x2="100" y2="21" stroke="#ff0000" stroke-width="3" stroke-dasharray="6 3.4"/></g>`;
    const parsed = parseSvgDecorations(svg);
    expect(parsed.clips.get("a")).toEqual([
      { x0: 0, x1: 40, y0: 18, y1: 24 },
      { x0: 60, x1: 100, y0: 18, y1: 24 },
    ]);
    expect(parsed.lines).toMatchObject([{ kind: "line", y: 21, w: 3, dash: [6, 3.4], clipId: "a" }]);
  });
  it("parses a wavy path's centerline, control-point distance, and clip", () => {
    const svg = `
      <clipPath id="w"><rect x="0" y="20" width="100" height="7"/></clipPath>
      <path d="M 0 23.5 C 5.5 31 5.5 16 11 23.5 C 16.5 31 16.5 16 22 23.5" fill="none" stroke="#ff0000" stroke-width="2" clip-path="url(#w)"/>`;
    const parsed = parseSvgDecorations(svg);
    expect(parsed.lines).toMatchObject([{ kind: "wavy", y: 23.5, w: 2, cpDist: 7.5, clipId: "w" }]);
    const bars = svgBarsInWindow(parsed, { top: 0, bottom: 100 });
    expect(bars).toHaveLength(1);
    // Ink extent: centerline ± (cpDist/(2√3) + t/2).
    const amp = 7.5 / (2 * Math.sqrt(3));
    expect(bars[0].top).toBeCloseTo(23.5 - amp - 1, 6);
    expect(bars[0].height).toBeCloseTo(2 * amp + 2, 6);
    // Segments = the clip rects' x-intervals.
    expect(bars[0].segments).toEqual([{ x0: 0, x1: 100 }]);
  });
  it("a dashed line expands its dash pattern and intersects the clip rects", () => {
    const svg = `
      <clipPath id="d"><rect x="0" y="18" width="20" height="6"/><rect x="50" y="18" width="50" height="6"/></clipPath>
      <g clip-path="url(#d)"><line x1="0" y1="21" x2="100" y2="21" stroke="#ff0000" stroke-width="3" stroke-dasharray="6 4"/></g>`;
    const bars = svgBarsInWindow(parseSvgDecorations(svg), { top: 0, bottom: 100 });
    expect(bars).toHaveLength(1);
    // Dashes at 0,10,20,... width 6; ∩ [0,20]∪[50,100]:
    expect(bars[0].segments).toEqual([
      { x0: 0, x1: 6 }, { x0: 10, x1: 16 },
      { x0: 50, x1: 56 }, { x0: 60, x1: 66 }, { x0: 70, x1: 76 }, { x0: 80, x1: 86 }, { x0: 90, x1: 96 },
    ]);
  });
});

describe("expandDashSegments", () => {
  const lineOf = (dash: number[] | undefined, roundCaps?: boolean) => ({
    kind: "line" as const, y: 21, w: 4, x0: 2, x1: 42, dash, roundCaps, clipId: undefined, cpDist: undefined,
  });
  it("walks the dasharray from the line start (SVG phase 0), clamping the last dash", () => {
    expect(expandDashSegments(lineOf([6, 4]), null)).toEqual([
      { x0: 2, x1: 8 }, { x0: 12, x1: 18 }, { x0: 22, x1: 28 }, { x0: 32, x1: 38 }, { x0: 42, x1: 42 },
    ].filter((s) => s.x1 - s.x0 > 0));
  });
  it("zero-length round-cap dashes paint dots of diameter stroke-width", () => {
    expect(expandDashSegments(lineOf([0, 10], true), null)).toEqual([
      { x0: 0, x1: 4 }, { x0: 10, x1: 14 }, { x0: 20, x1: 24 }, { x0: 30, x1: 34 }, { x0: 40, x1: 44 },
    ]);
  });
  it("no dasharray → one solid segment", () => {
    expect(expandDashSegments(lineOf(undefined), null)).toEqual([{ x0: 2, x1: 42 }]);
  });
});

describe("compareSegments", () => {
  it("passes when every edge is within tolerance", () => {
    const r = compareSegments([[10, 40], [60, 100]], [[10.5, 39.6], [60.2, 100]]);
    expect(r.ok).toBe(true);
  });
  it("fails on an edge beyond tolerance", () => {
    const r = compareSegments([[10, 40]], [[12, 40]]);
    expect(r.ok).toBe(false);
  });
  it("fails on segment-count mismatch, ignoring sub-1px slivers", () => {
    expect(compareSegments([[10, 40]], [[10, 40], [50, 50.5]]).ok).toBe(true);
    expect(compareSegments([[10, 40]], [[10, 40], [50, 55]]).ok).toBe(false);
  });
  it("forgives a one-sided filter-boundary sliver but keeps grading later pairs by overlap", () => {
    // Chrome kept a 1.2px dash fragment our sub-tolerance edge drift dropped;
    // the later segments still pair up and their edges still gate.
    expect(compareSegments([[10, 11.2], [20, 26], [30, 36]], [[20, 26], [30, 36]]).ok).toBe(true);
    expect(compareSegments([[10, 11.2], [20, 26], [30, 36]], [[20, 26], [32, 36]]).ok).toBe(false);
  });
  it("does not forgive a missing WIDE segment (a swallowed gap or dropped dash)", () => {
    expect(compareSegments([[10, 16], [20, 26]], [[20, 26]]).ok).toBe(false);
  });
});
