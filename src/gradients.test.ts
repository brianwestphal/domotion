import { describe, expect, it } from "vitest";
import { buildLinearGradientDef, parseConicGradient, parseGradient, parseLinearGradient } from "./gradients.js";

describe("parseLinearGradient: repeating support (DM-275)", () => {
  it("parses repeating-linear-gradient with the repeating flag set", () => {
    const g = parseLinearGradient("repeating-linear-gradient(90deg, red 0%, blue 10%)");
    expect(g).not.toBeNull();
    expect(g!.kind).toBe("linear");
    expect(g!.repeating).toBe(true);
    expect(g!.angleDeg).toBe(90);
    expect(g!.stops).toHaveLength(2);
  });

  it("plain linear-gradient leaves repeating undefined", () => {
    const g = parseLinearGradient("linear-gradient(90deg, red 0%, blue 100%)");
    expect(g).not.toBeNull();
    expect(g!.repeating).toBeUndefined();
  });
});

describe("parseGradient: calc(N% ± Mpx) stop positions", () => {
  it("captures calc offsets on stops via calcOffset (DM-275)", () => {
    const g = parseGradient(
      "repeating-linear-gradient(90deg, transparent 0px, transparent calc(10% - 1px), rgb(148, 163, 184) calc(10% - 1px), rgb(148, 163, 184) 10%)",
    );
    expect(g).not.toBeNull();
    expect(g!.kind).toBe("linear");
    expect(g!.stops).toHaveLength(4);
    const stops = g!.stops as Array<{ calcOffset?: { pct: number; px: number } }>;
    expect(stops[1].calcOffset).toEqual({ pct: 10, px: -1 });
    expect(stops[2].calcOffset).toEqual({ pct: 10, px: -1 });
  });

  it("supports calc with reversed term order and pure %", () => {
    const g = parseLinearGradient("linear-gradient(0deg, red calc(2px + 10%), blue 50%)");
    expect(g!.stops[0].calcOffset).toEqual({ pct: 10, px: 2 });
  });
});

describe("buildLinearGradientDef: repeating tiles across the gradient line", () => {
  it("emits multiple tiles spanning [0, 1] with calc-resolved offsets", () => {
    // A 100px-wide rect with a repeating-linear-gradient running 90deg means
    // the gradient line length L=100. Period 10% = 10px → 10 tiles.
    const g = parseGradient(
      "repeating-linear-gradient(90deg, transparent 0px, transparent calc(10% - 1px), rgb(148, 163, 184) calc(10% - 1px), rgb(148, 163, 184) 10%)",
    )!;
    const svg = buildLinearGradientDef(g as any, "g0", { x: 0, y: 0, w: 100, h: 6 });
    // 10 full tiles × 4 stops + the one boundary stop at offset 1 from the
    // 11th tile's first stop — out-of-range stops within that tile are
    // clipped out. Allow some slack for boundary/rounding.
    const stopCount = (svg.match(/<stop /g) || []).length;
    expect(stopCount).toBeGreaterThanOrEqual(40);
    expect(stopCount).toBeLessThanOrEqual(44);
    expect(svg).toContain('id="g0"');
    expect(svg).toContain('stop-color="rgb(148, 163, 184)"');
    // First and last offsets at the ends of the gradient line.
    expect(svg).toContain('offset="0"');
    expect(svg).toContain('offset="1"');
  });

  it("non-repeating gradients still emit their two stops unchanged", () => {
    const g = parseLinearGradient("linear-gradient(90deg, red, blue)")!;
    const svg = buildLinearGradientDef(g, "g1", { x: 0, y: 0, w: 100, h: 10 });
    expect((svg.match(/<stop /g) || []).length).toBe(2);
  });
});

describe("parseConicGradient (DM-548)", () => {
  it("parses bare conic-gradient with default origin and center", () => {
    const g = parseConicGradient("conic-gradient(red, yellow, green, blue)");
    expect(g).not.toBeNull();
    expect(g!.kind).toBe("conic");
    expect(g!.fromAngleDeg).toBe(0);
    expect(g!.position).toEqual({ x: { kind: "frac", value: 0.5 }, y: { kind: "frac", value: 0.5 } });
    expect(g!.stops).toHaveLength(4);
    expect(g!.repeating).toBeUndefined();
  });

  it("parses repeating-conic-gradient with the repeating flag set", () => {
    const g = parseConicGradient("repeating-conic-gradient(#ddd 0 25%, white 0 50%)");
    expect(g).not.toBeNull();
    expect(g!.repeating).toBe(true);
    // Hard-stop double-position form: 4 stops total (each color emitted twice).
    expect(g!.stops).toHaveLength(4);
    expect(g!.stops[0].offset).toBe(0);
    expect(g!.stops[1].offset).toBe(0.25);
    expect(g!.stops[2].offset).toBe(0);
    expect(g!.stops[3].offset).toBe(0.5);
  });

  it("parses `from <angle>` clause", () => {
    const g = parseConicGradient("conic-gradient(from 90deg, red, blue)");
    expect(g!.fromAngleDeg).toBe(90);
    expect(g!.stops).toHaveLength(2);
  });

  it("parses `from <turn>` and converts to degrees", () => {
    const g = parseConicGradient("conic-gradient(from 0.25turn, red, blue)");
    expect(g!.fromAngleDeg).toBe(90);
  });

  it("parses `at <position>` clause", () => {
    const g = parseConicGradient("conic-gradient(at 25% 75%, red, blue)");
    expect(g!.position).toEqual({ x: { kind: "frac", value: 0.25 }, y: { kind: "frac", value: 0.75 } });
    expect(g!.fromAngleDeg).toBe(0);
  });

  it("parses `at top right` keyword position", () => {
    const g = parseConicGradient("conic-gradient(at top right, red, blue)");
    // top right → x=right(1), y=top(0). The pair-parser swaps when 'top' precedes a side keyword.
    expect(g!.position.x).toEqual({ kind: "frac", value: 1 });
    expect(g!.position.y).toEqual({ kind: "frac", value: 0 });
  });

  it("parses combined `from <angle> at <position>`", () => {
    const g = parseConicGradient("conic-gradient(from 0.25turn at top right, red, blue)");
    expect(g!.fromAngleDeg).toBe(90);
    expect(g!.position.x).toEqual({ kind: "frac", value: 1 });
    expect(g!.position.y).toEqual({ kind: "frac", value: 0 });
  });

  it("parses angle-positioned stops (deg)", () => {
    const g = parseConicGradient("conic-gradient(red 0deg, yellow 90deg, blue 180deg)");
    expect(g!.stops[0].offset).toBe(0);
    expect(g!.stops[1].offset).toBe(0.25);
    expect(g!.stops[2].offset).toBe(0.5);
  });

  it("parses turn-positioned stops", () => {
    const g = parseConicGradient("conic-gradient(red 0turn, blue 0.5turn)");
    expect(g!.stops[0].offset).toBe(0);
    expect(g!.stops[1].offset).toBe(0.5);
  });

  it("parses percentage-positioned stops", () => {
    const g = parseConicGradient("conic-gradient(red 0%, yellow 50%, blue 100%)");
    expect(g!.stops[0].offset).toBe(0);
    expect(g!.stops[1].offset).toBe(0.5);
    expect(g!.stops[2].offset).toBe(1);
  });

  it("parses double-position hard stops", () => {
    const g = parseConicGradient("conic-gradient(red 0% 25%, blue 25% 50%)");
    expect(g!.stops).toHaveLength(4);
    expect(g!.stops[0]).toMatchObject({ color: "red", offset: 0 });
    expect(g!.stops[1]).toMatchObject({ color: "red", offset: 0.25 });
    expect(g!.stops[2]).toMatchObject({ color: "blue", offset: 0.25 });
    expect(g!.stops[3]).toMatchObject({ color: "blue", offset: 0.5 });
  });

  it("preserves rgba/rgb color text including modern slash-alpha syntax", () => {
    const g = parseConicGradient("conic-gradient(rgb(255, 0, 0) 0%, rgba(0, 0, 255, 0.5) 100%)");
    expect(g!.stops[0].color).toBe("rgb(255, 0, 0)");
    expect(g!.stops[1].color).toBe("rgba(0, 0, 255, 0.5)");
  });

  it("rejects malformed text", () => {
    expect(parseConicGradient("conic-gradient()")).toBeNull();
    expect(parseConicGradient("conic-gradient(red)")).toBeNull();
    expect(parseConicGradient("linear-gradient(red, blue)")).toBeNull();
    expect(parseConicGradient(null)).toBeNull();
    expect(parseConicGradient(undefined)).toBeNull();
  });

  it("is reachable via parseGradient dispatch", () => {
    const g = parseGradient("conic-gradient(red, blue)");
    expect(g).not.toBeNull();
    expect(g!.kind).toBe("conic");
  });

  it("parseGradient still picks linear/radial first when matching", () => {
    expect(parseGradient("linear-gradient(red, blue)")?.kind).toBe("linear");
    expect(parseGradient("radial-gradient(red, blue)")?.kind).toBe("radial");
  });
});
