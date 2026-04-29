import { describe, expect, it } from "vitest";
import { buildLinearGradientDef, parseGradient, parseLinearGradient } from "./gradients.js";

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
    expect(g!.stops).toHaveLength(4);
    expect(g!.stops[1].calcOffset).toEqual({ pct: 10, px: -1 });
    expect(g!.stops[2].calcOffset).toEqual({ pct: 10, px: -1 });
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
