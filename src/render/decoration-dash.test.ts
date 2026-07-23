// DM-1724: Chromium-parity dashed / dotted decoration dash geometry
// (styled_stroke_data.cc DashEffectFromStrokeStyle + SelectBestDashGap,
// decoration_line_painter.cc DrawLineAsStroke).
import { describe, expect, it } from "vitest";

import { decorationDashPattern } from "./text.js";

function dashArray(attrs: string): number[] | null {
  const m = attrs.match(/stroke-dasharray="([^"]+)"/);
  return m == null ? null : m[1].split(" ").map(Number);
}

describe("decorationDashPattern: dashed", () => {
  it("thin (ti<3): dash=3ti gap=2ti before fitting", () => {
    // t=2 → ti=2 → dash 6, ideal gap 4. L=100: available=104, minN=floor(104/10)=10,
    // minGap=(100-60)/9≈4.44, maxN=11, maxGap=(100-66)/10=3.4; |4.44-4|=0.44 < |3.4-4|=0.6 → 4.444
    const p = decorationDashPattern("dashed", 2, 100);
    const [dash, gap] = dashArray(p.attrs)!;
    expect(dash).toBe(6);
    expect(gap).toBeCloseTo(4.444, 1); // r() emits 0.1px precision (4.4)
    expect(p.inset).toBe(0);
    expect(p.attrs).not.toContain("linecap");
  });

  it("thick (ti>=3): dash=2ti gap=1ti before fitting", () => {
    const p = decorationDashPattern("dashed", 4, 200);
    const [dash] = dashArray(p.attrs)!;
    expect(dash).toBe(8);
  });

  it("gap fitting spans the run with a whole number of dashes (n·dash + (n−1)·gap = L)", () => {
    const p = decorationDashPattern("dashed", 2, 100);
    const [dash, gap] = dashArray(p.attrs)!;
    // 10 dashes + 9 gaps: 10*6 + 9*4.444... = 100 (±the 0.1px emit precision per gap)
    expect(10 * dash + 9 * gap).toBeCloseTo(100, 0);
  });

  it("uses the ROUNDED thickness for dash geometry", () => {
    // t=1.7 → ti=2, same pattern as t=2 (Chrome: dash_thickness = roundf(t))
    const a = decorationDashPattern("dashed", 1.7, 100);
    const b = decorationDashPattern("dashed", 2, 100);
    expect(a.attrs).toBe(b.attrs);
  });

  it("falls back to the float thickness when rounding hits 0", () => {
    const p = decorationDashPattern("dashed", 0.4, 100);
    const [dash] = dashArray(p.attrs)!;
    expect(dash).toBeCloseTo(1.2, 5); // 0.4 × 3
  });

  it("run too short for two dashes → solid (no dasharray)", () => {
    // ti=2 → dash 6; L=12 = 2·dash → solid
    const p = decorationDashPattern("dashed", 2, 12);
    expect(p.attrs).toBe("");
  });

  it("run shorter than 2·dash+gap → exactly two proportional dashes", () => {
    // ti=2 → dash 6 gap 4, 2d+g=16; L=14 → m=0.875 → dash 5.25 gap 3.5
    const p = decorationDashPattern("dashed", 2, 14);
    const [dash, gap] = dashArray(p.attrs)!;
    expect(dash).toBeCloseTo(5.25, 1);
    expect(gap).toBeCloseTo(3.5, 1);
    // Two dashes + one gap fill the run (±the 0.1px emit precision).
    expect(2 * dash + gap).toBeCloseTo(14, 0);
  });
});

describe("decorationDashPattern: dotted", () => {
  it("thin (ti<=3): square dots {ti, ti}, butt caps, no fitting", () => {
    const p = decorationDashPattern("dotted", 2, 100);
    expect(dashArray(p.attrs)).toEqual([2, 2]);
    expect(p.attrs).not.toContain("linecap");
    expect(p.inset).toBe(0);
  });

  it("thick (ti>3): round dots — zero-length dashes, round caps, ti/2 endpoint inset", () => {
    const p = decorationDashPattern("dotted", 4, 100);
    const [zero, period] = dashArray(p.attrs)!;
    expect(zero).toBe(0);
    expect(p.attrs).toContain('stroke-linecap="round"');
    expect(p.inset).toBe(2);
    // gap fitted (SelectBestDashGap(100, 4, 4)) + ti − ε; dot centers span the run.
    expect(period).toBeGreaterThan(4);
  });

  it("thick dotted run too short for two dots → single dot", () => {
    const p = decorationDashPattern("dotted", 4, 6);
    expect(dashArray(p.attrs)).toEqual([0, 8]);
    expect(p.attrs).toContain('stroke-linecap="round"');
  });

  it("thin dotted too-short run → solid, mirroring the dashed short-circuit", () => {
    // ti=2, dash=gap=2, L=4 = 2·dash → solid
    const p = decorationDashPattern("dotted", 2, 4);
    expect(p.attrs).toBe("");
  });
});
