import { describe, expect, it } from "vitest";
import {
  barCaretHeightPx,
  caretShapeRect,
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
