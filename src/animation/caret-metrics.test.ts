import { describe, expect, it } from "vitest";
import {
  barCaretHeightPx,
  caretShapeRect,
  firstLineBaseline,
  underscoreCaretThicknessPx,
  BLOCK_CARET_ALPHA,
  DEFAULT_CARET_WIDTH_PX,
} from "./caret-metrics.js";

describe("barCaretHeightPx (DM-1587/1590)", () => {
  it("uses exact ascent+descent when given, else the 1.15×em fallback", () => {
    expect(barCaretHeightPx(20, 14.5, 3.2)).toBe(18); // round(17.7)
    expect(barCaretHeightPx(20)).toBe(23); // round(20 * 1.15)
  });
});

describe("caretShapeRect — bar / block / underscore geometry (DM-1591)", () => {
  const base = { x: 100, baselineY: 40, ascentPx: 15, descentPx: 5, cellWidthPx: 12, fontSize: 20 };

  it("bar: thin, spans the font box, opaque", () => {
    const r = caretShapeRect({ ...base, shape: "bar" });
    expect(r).toEqual({ x: 100, y: 25, width: DEFAULT_CARET_WIDTH_PX, height: 20, opacity: 1 });
  });

  it("bar: honors a barWidthPx override", () => {
    expect(caretShapeRect({ ...base, shape: "bar", barWidthPx: 1.5 }).width).toBe(1.5);
  });

  it("block: one cell wide, spans the font box, translucent (0.5)", () => {
    const r = caretShapeRect({ ...base, shape: "block" });
    expect(r).toEqual({ x: 100, y: 25, width: 12, height: 20, opacity: BLOCK_CARET_ALPHA });
  });

  it("underscore: one cell wide, thin, sits on the baseline, opaque", () => {
    const r = caretShapeRect({ ...base, shape: "underscore" });
    expect(r).toEqual({ x: 100, y: 40, width: 12, height: underscoreCaretThicknessPx(20), opacity: 1 });
    // top of the underscore is AT the baseline (not up in the font box)
    expect(r.y).toBe(base.baselineY);
  });

  it("clamps a zero/negative cell width to 1px", () => {
    expect(caretShapeRect({ ...base, shape: "block", cellWidthPx: 0 }).width).toBe(1);
  });
});

describe("underscoreCaretThicknessPx", () => {
  it("is ~1/12 em with a 1px floor", () => {
    expect(underscoreCaretThicknessPx(24)).toBe(2);
    expect(underscoreCaretThicknessPx(12)).toBe(1);
    expect(underscoreCaretThicknessPx(6)).toBe(1); // floored
  });
});

// DM-1750: the extracted first-line-baseline placement math — the line box sits
// at the content top (or centered for a single-line input) and the text box
// (ascent + descent, rounded) is centered in it under CSS half-leading, with the
// baseline `ascent` below the text-box top. Shared by the typeResample caret and
// the typing overlay's `anchor.baseline` resolution.
describe("firstLineBaseline (DM-1750)", () => {
  it("block/textarea content: line box from the content top", () => {
    // lineH 20, text box round(12 + 4) = 16 → boxTop = 100 + (20−16)/2 = 102,
    // baseline = 102 + 12 = 114.
    const r = firstLineBaseline({ fontSize: 14, lineHeightPx: 20, fontAscentPx: 12, fontDescentPx: 4, contentTop: 100, contentHeight: 60, centerInContentBox: false });
    expect(r).toEqual({ baselineY: 114, ascentPx: 12, descentPx: 4 });
  });

  it("single-line input: line box centered in the content box", () => {
    // lineTop = 100 + (30 − 20)/2 = 105 → boxTop = 107, baseline = 119.
    const r = firstLineBaseline({ fontSize: 14, lineHeightPx: 20, fontAscentPx: 12, fontDescentPx: 4, contentTop: 100, contentHeight: 30, centerInContentBox: true });
    expect(r.baselineY).toBe(119);
  });

  it("line-height: normal (0) falls back to the font box", () => {
    // lineH = fontBox = 16, text box 16 → boxTop = contentTop, baseline = top + ascent.
    const r = firstLineBaseline({ fontSize: 14, lineHeightPx: 0, fontAscentPx: 12, fontDescentPx: 4, contentTop: 50, contentHeight: 40, centerInContentBox: false });
    expect(r.baselineY).toBe(62);
  });

  it("no font box (0/0) falls back to the 1.15-em split (0.9 asc + 0.25 desc)", () => {
    const r = firstLineBaseline({ fontSize: 20, lineHeightPx: 0, fontAscentPx: 0, fontDescentPx: 0, contentTop: 0, contentHeight: 40, centerInContentBox: false });
    expect(r.ascentPx).toBe(18);
    expect(r.descentPx).toBe(5);
    // lineH = 20 × 1.2 = 24, text box round(23) = 23 → boxTop 0.5, baseline 18.5.
    expect(r.baselineY).toBe(18.5);
  });
});
