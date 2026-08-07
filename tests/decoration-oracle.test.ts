import { describe, expect, it } from "vitest";
import {
  compareSegments,
  lengthPx,
  parseSvgDecorations,
  predictCase,
  svgBarsInWindow,
  type CaseSpec,
  type PageMeasure,
} from "../tools/decoration-oracle.js";

// Hand-computed expectations against the transcribed Blink rules
// (Chromium rev 7d859f27): thickness `core/paint/text_decoration_info.cc:65-92`
// + max(1,t) at :449-451; underline offset `core/layout/text_decoration_offset.cc:16-35`;
// line-through `text_decoration_info.cc:385-386`; paint snap
// `core/paint/decoration_line_painter.cc` SnapYAxis/RoundDownThickness.
const meas = (ascF: number): PageMeasure => ({
  rect: { x: 10, y: 100, w: 200, h: 28 },
  baselineY: 100 + ascF,
  ascF,
  descF: 6,
  fragments: 1,
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
  it("thickness never predicts below 1px", () => {
    const p = predictCase({ ...base, fontSize: 8 }, { ...meas(8), rect: { x: 10, y: 100, w: 80, h: 10 } });
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
    const lines = parseSvgDecorations(svg);
    expect(lines).toEqual([
      { y: 50, w: 2, x0: 5, x1: 105 },
      { y: 141, w: 3, x0: 15, x1: 95 },
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
});
