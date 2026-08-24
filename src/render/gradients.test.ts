import { describe, expect, it } from "vitest";
import { buildLinearGradientDef, buildRadialGradientDef, parseConicGradient, parseGradient, parseLegacyWebkitGradient, parseLinearGradient, parseRadialGradient } from "./gradients.js";
import { buildLinearGradientDef as buildBackgroundLinearGradientDef, buildRadialGradientDef as buildBackgroundRadialGradientDef, normalizeRadialGradientDomain } from "./gradient-defs.js";

describe("convertLegacyWebkitGradient: legacy -webkit-gradient(linear, ...)", () => {
  it("vertical top-to-bottom from()/to() form (slashdot mobile header)", () => {
    // Slashdot's mobile header background, as Chromium serializes it.
    const g = parseGradient(
      "-webkit-gradient(linear, 0% 0%, 0% 100%, from(rgb(0, 0, 0)), to(rgb(32, 32, 32)))",
    );
    expect(g).not.toBeNull();
    expect(g!.kind).toBe("linear");
    const lg = g as { kind: "linear"; angleDeg: number; stops: Array<{ color: string; offset?: number }> };
    expect(lg.angleDeg).toBe(180);
    expect(lg.stops).toHaveLength(2);
    expect(lg.stops[0].color).toBe("rgb(0, 0, 0)");
    expect(lg.stops[0].offset).toBe(0);
    expect(lg.stops[1].color).toBe("rgb(32, 32, 32)");
    expect(lg.stops[1].offset).toBe(1);
  });

  it("horizontal with side keyword endpoints", () => {
    const g = parseGradient(
      "-webkit-gradient(linear, left top, right top, from(red), to(blue))",
    );
    expect(g).not.toBeNull();
    expect(g!.kind).toBe("linear");
    expect((g as { angleDeg: number }).angleDeg).toBe(90);
  });

  it("intermediate color-stop() entries pass through", () => {
    const g = parseGradient(
      "-webkit-gradient(linear, 0% 0%, 0% 100%, from(red), color-stop(0.5, green), to(blue))",
    );
    expect(g).not.toBeNull();
    const lg = g as { kind: "linear"; stops: Array<{ color: string; offset?: number }> };
    expect(lg.stops).toHaveLength(3);
    expect(lg.stops[1].color).toBe("green");
    expect(lg.stops[1].offset).toBe(0.5);
  });

  it("diagonal legacy webkit-gradient maps to a 135deg gradient (DM-1241)", () => {
    // top-left → bottom-right: atan2(dx=1, -dy=-1) = 135deg ("to bottom right").
    const g = parseGradient("-webkit-gradient(linear, 0% 0%, 100% 100%, from(red), to(blue))");
    expect(g).not.toBeNull();
    expect(g!.kind).toBe("linear");
    expect((g as { angleDeg: number }).angleDeg).toBe(135);
    expect(buildLinearGradientDef(g as any, "legacy", { x: 10, y: 20, w: 200, h: 80 }))
      .toContain('x1="10" y1="20" x2="210" y2="100"');
  });

  it("preserves arbitrary percentage and unitless endpoints instead of applying magic-corner geometry", () => {
    const percent = parseGradient("-webkit-gradient(linear, 10% 25%, 80% 75%, from(red), color-stop(75%, lime), to(blue))")!;
    expect(buildLinearGradientDef(percent as any, "p", { x: 5, y: 7, w: 300, h: 120 }))
      .toContain('x1="35" y1="37" x2="245" y2="97"');
    const numbers = parseGradient("-webkit-gradient(linear, 12 8, 112 48, from(red), to(blue))")!;
    expect(buildLinearGradientDef(numbers as any, "q", { x: 20, y: 30, w: 400, h: 200 }))
      .toContain('x1="32" y1="38" x2="132" y2="78"');
    expect(parseGradient("-webkit-gradient(linear, 12px 8px, 112px 48px, from(red), to(blue))")).toBeNull();
  });

  it("stable-sorts deprecated stops as Blink does", () => {
    const g = parseGradient("-webkit-gradient(linear, left top, right bottom, color-stop(.8, blue), from(red), color-stop(.2, green))")!;
    expect(g.stops.map((stop) => stop.color)).toEqual(["red", "green", "blue"]);
  });

  it("bottom-left → top-right diagonal maps to 45deg", () => {
    const g = parseGradient("-webkit-gradient(linear, left bottom, right top, from(red), to(blue))");
    expect((g as { angleDeg: number }).angleDeg).toBe(45);
  });

  it("preserves Blink's degenerate endpoint record instead of substituting modern geometry", () => {
    const g = parseGradient("-webkit-gradient(linear, 50% 50%, 50% 50%, from(red), to(blue))");
    expect(g?.kind).toBe("linear");
    expect(buildLinearGradientDef(g as any, "degenerate", { x: 10, y: 20, w: 200, h: 80 }))
      .toContain('x1="110" y1="60" x2="110" y2="60"');
  });

  it("uses the axis-specific legacy keyword grammar", () => {
    expect(parseGradient("-webkit-gradient(linear, top left, right bottom, from(red), to(blue))")).toBeNull();
    expect(parseGradient("-webkit-gradient(linear, left top, right bottom, from(red), to(blue))")).not.toBeNull();
    expect(parseGradient("-webkit-gradient(linear, left top, right bottom, from(currentColor), to(blue))")).toBeNull();
    expect(parseGradient("-webkit-gradient(linear, left top,, right bottom, from(red), to(blue))")).toBeNull();
  });

  it("stable-sorts before Skia's terminal clamp for negative and out-of-range stops", () => {
    const g = parseGradient("-webkit-gradient(linear, left top, right bottom, color-stop(1.2, yellow), to(blue), color-stop(-.2, green), from(red))")!;
    expect(g.stops.map((stop) => [stop.color, stop.offset])).toEqual([
      ["green", -0.2], ["red", 0], ["blue", 1], ["yellow", 1.2],
    ]);
    const svg = buildLinearGradientDef(g as any, "clamped", { x: 0, y: 0, w: 200, h: 80 });
    expect([...svg.matchAll(/<stop offset="([^"]+)" stop-color="([^"]+)"/g)].map((match) => [Number(match[1]), match[2]]))
      .toEqual([[0, "green"], [0, "red"], [1, "blue"], [1, "yellow"]]);
  });

  it("parses two-circle radial geometry without modern radial normalization", () => {
    const g = parseLegacyWebkitGradient("-webkit-gradient(radial, 10% 25%, 5, 80% 75%, 40, from(red), color-stop(.5, lime), to(blue))")!;
    expect(g.kind).toBe("radial");
    const svg = buildRadialGradientDef(g as any, "legacy-r", { x: 5, y: 7, w: 300, h: 120 });
    expect(svg).toContain('fx="35" fy="37" fr="5" cx="245" cy="97" r="40"');
    expect(svg).not.toContain("spreadMethod");
  });

  it("reverses shrinking two-circle radial geometry into SVG's fr <= r domain", () => {
    const g = parseLegacyWebkitGradient("-webkit-gradient(radial, 80% 75%, 40, 10% 25%, 5, from(red), color-stop(.25, lime), to(blue))")!;
    const svg = buildRadialGradientDef(g as any, "legacy-shrink", { x: 5, y: 7, w: 300, h: 120 });
    expect(svg).toContain('fx="35" fy="37" fr="5" cx="245" cy="97" r="40"');
    expect([...svg.matchAll(/<stop offset="([^"]+)" stop-color="([^"]+)"/g)].map((match) => [Number(match[1]), match[2]]))
      .toEqual([[0, "blue"], [0.75, "lime"], [1, "red"]]);
  });

  it("accepts Blink's zero- and one-stop deprecated forms", () => {
    const empty = parseGradient("-webkit-gradient(linear, left top, right bottom)");
    const one = parseGradient("-webkit-gradient(radial, left top, 0, right bottom, 40, from(red))");
    expect(empty?.stops).toEqual([]);
    expect(one?.stops).toEqual([{ color: "red", offset: 0 }]);
  });
});

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

  it("uses exact CSS absolute-length conversions", () => {
    const g = parseLinearGradient("linear-gradient(90deg, red 1in, blue calc(50% + 12pt))")!;
    expect(g.stops[0].pxOffset).toBe(96);
    expect(g.stops[1].calcOffset).toEqual({ pct: 50, px: 16 });
  });

  it("rejects context-dependent units instead of assuming a 16px font", () => {
    expect(parseLinearGradient("linear-gradient(red 2em, blue 4em)")).toBeNull();
    expect(parseLinearGradient("linear-gradient(red calc(50% + 1rem), blue)")).toBeNull();
  });
});

describe("radial gradient length boundary (DM-2194)", () => {
  it("accepts computed px radii and rejects unresolved font-relative radii", () => {
    expect(parseRadialGradient("radial-gradient(circle 24px, red, blue)")?.size)
      .toEqual({ kind: "px", r1: 24 });
    expect(parseRadialGradient("radial-gradient(circle 2em, red, blue)")).toBeNull();
  });
});

describe("repeating radial gradient period geometry (DM-2290)", () => {
  it("makes the 20px CSS period the SVG radial vector instead of padding the ending color", () => {
    const svg = buildBackgroundRadialGradientDef(
      "g", "circle at center, #0ea5e9 0 10px, #bae6fd 10px 20px", true,
      0, 0, 288, 120,
    );
    expect(svg).toContain('r="20"');
    expect(svg).toContain('spreadMethod="repeat"');
    expect(svg).toContain('offset="0.5"');
    expect(svg).toContain('offset="1"');
  });

  it("resolves percentage stops against the computed x radius in a non-square box", () => {
    const svg = buildBackgroundRadialGradientDef(
      "g", "circle 100px at 25% 75%, red 0%, blue 20%", true,
      10, 20, 200, 80,
    );
    expect(svg).toContain('cx="60"');
    expect(svg).toContain('cy="80"');
    expect(svg).toContain('r="20"');
  });

  it("uses SVG's focal radius for a positive first stop so inward repetition keeps its phase", () => {
    const svg = buildBackgroundRadialGradientDef(
      "g", "circle 100px at 30% 40%, red 10px, blue 30px", true,
      0, 0, 200, 100,
    );
    expect(svg).toContain('fr="10"');
    expect(svg).toContain('r="30"');
    expect(svg).toContain('fx="60"');
    expect(svg).toContain('fy="40"');
    expect(svg).toContain('spreadMethod="repeat"');
  });

  it("collapses a coincident period to the final solid color", () => {
    const svg = buildBackgroundRadialGradientDef(
      "g", "circle 100px, red 10px, blue 10px", true,
      0, 0, 200, 100,
    );
    expect(svg).not.toContain("spreadMethod");
    expect((svg.match(/stop-color="rgb\(0,0,255\)"/g) ?? [])).toHaveLength(2);
    expect(svg).not.toContain("rgb(255,0,0)");
  });

  it("also collapses a period below SVG serialization precision", () => {
    const svg = buildBackgroundRadialGradientDef(
      "g", "circle 100px, red 10px, blue 10.000001px", true,
      0, 0, 200, 100,
    );
    expect(svg).not.toContain("spreadMethod");
    expect((svg.match(/stop-color="rgb\(0,0,255\)"/g) ?? [])).toHaveLength(2);
  });
});

describe("radial gradient negative-domain normalization (DM-2326)", () => {
  const stop = (pos: number, r: number, b: number) => ({ pos, color: { r, g: 0, b, a: 1 } });

  it("shifts a negative repeating radius interval forward by whole periods", () => {
    const domain = normalizeRadialGradientDomain([stop(-0.3, 255, 0), stop(-0.1, 0, 255)], 100, true);
    expect(domain).toMatchObject({ innerRadius: 10, outerRadius: 30, repeat: true });
    expect(domain.stops.map((value) => value.pos)).toEqual([0, 1]);
  });

  it("emits the shifted radii through the production SVG builder", () => {
    const svg = buildBackgroundRadialGradientDef(
      "g", "circle 100px, red -30px, blue -10px", true, 0, 0, 200, 200,
    );
    expect(svg).toContain('fr="10"');
    expect(svg).toContain('r="30"');
    expect(svg).toContain('spreadMethod="repeat"');
  });

  it("shifts a straddling repeating interval without clamping its phase to zero", () => {
    const domain = normalizeRadialGradientDomain([stop(-0.1, 255, 0), stop(0.1, 0, 255)], 100, true);
    expect(domain).toMatchObject({ innerRadius: 10, outerRadius: 30, repeat: true });
  });

  it("interpolates the zero-radius color and contracts a non-repeating domain", () => {
    const domain = normalizeRadialGradientDomain([stop(-0.2, 255, 0), stop(0.8, 0, 255)], 100, false);
    expect(domain).toMatchObject({ innerRadius: 0, outerRadius: 80, repeat: false });
    expect(domain.stops.map((value) => value.pos)).toEqual([0, 1]);
    expect(domain.stops[0].color).toEqual({ r: 204, g: 0, b: 51, a: 1 });
  });

  it("emits the contracted non-repeating radius and boundary color", () => {
    const svg = buildBackgroundRadialGradientDef(
      "g", "circle 100px, rgb(255, 0, 0) -20px, rgb(0, 0, 255) 80px", false, 0, 0, 200, 200,
    );
    expect(svg).toContain('r="80"');
    expect(svg).toContain('stop-color="rgb(204,0,51)"');
  });

  it("uses the declared linear-light space for the zero-radius boundary color", () => {
    const domain = normalizeRadialGradientDomain([stop(-0.2, 255, 0), stop(0.8, 0, 255)], 100, false, "srgb-linear");
    expect(domain.stops[0].color).toEqual({ r: 231, g: 0, b: 124, a: 1 });
  });

  it("expands a non-repeating domain whose final stop lies beyond the ending shape", () => {
    const domain = normalizeRadialGradientDomain([stop(0.2, 255, 0), stop(1.4, 0, 255)], 100, false);
    expect(domain).toMatchObject({ innerRadius: 20, outerRadius: 140, repeat: false });
    expect(domain.stops.map((value) => value.pos)).toEqual([0, 1]);
  });

  it("collapses a coincident repeating interval to the final color", () => {
    const domain = normalizeRadialGradientDomain([stop(-0.2, 255, 0), stop(-0.2, 0, 255)], 100, true);
    expect(domain).toMatchObject({ innerRadius: 0, outerRadius: 100, repeat: false });
    expect(domain.stops).toEqual([stop(0, 0, 255), stop(1, 0, 255)]);
  });
});

describe("background gradient computed-length boundary (DM-2194)", () => {
  it("resolves preserved percentages and px inside calc against the gradient line", () => {
    const svg = buildBackgroundLinearGradientDef(
      "g", "90deg, red calc(25% + 10px), blue 100%", false, 200, 40,
    );
    expect(svg).toContain('offset="0.3"');
  });

  it("rejects unresolved context-dependent units instead of parseFloat coercion", () => {
    expect(buildBackgroundLinearGradientDef("g", "90deg, red 2em, blue 4em", false, 200, 40)).toBe("");
    expect(buildBackgroundLinearGradientDef("g", "90deg, red calc(25% + 1rem), blue", false, 200, 40)).toBe("");
  });
});

describe("background gradient magic corners (DM-2297)", () => {
  it("uses Blink's perpendicular-to-corner line on a landscape box", () => {
    // Chromium css_gradient_value.cc:1410-1430 computes the bearing as
    // 90 - atan2(width, height), then EndPointsFromAngle projects the two
    // magic-corner endpoints. A direct atan2(width,height) vector would emit
    // (0,100)→(300,0) here and is the historical Domotion bug.
    const svg = buildBackgroundLinearGradientDef(
      "g", "to top right, red, blue", false, 300, 100,
    );
    expect(svg).toContain('x1="120"');
    expect(svg).toContain('y1="140"');
    expect(svg).toContain('x2="180"');
    expect(svg).toContain('y2="-40"');
  });

  it("mirrors the same source rule into the opposite corner", () => {
    const svg = buildBackgroundLinearGradientDef(
      "g", "to bottom left, red, blue", false, 300, 100, 10, 20,
    );
    expect(svg).toContain('x1="190"');
    expect(svg).toContain('y1="-20"');
    expect(svg).toContain('x2="130"');
    expect(svg).toContain('y2="160"');
  });
});

describe("buildLinearGradientDef: repeating domains", () => {
  it("moves the vector to one calc-resolved period and uses native repeat", () => {
    // A 100px-wide rect with a repeating-linear-gradient running 90deg means
    // the gradient line length L=100. Period 10% = 10px → 10 tiles.
    const g = parseGradient(
      "repeating-linear-gradient(90deg, transparent 0px, transparent calc(10% - 1px), rgb(148, 163, 184) calc(10% - 1px), rgb(148, 163, 184) 10%)",
    )!;
    const svg = buildLinearGradientDef(g as any, "g0", { x: 0, y: 0, w: 100, h: 6 });
    const stopCount = (svg.match(/<stop /g) || []).length;
    expect(stopCount).toBe(4);
    expect(svg).toContain('id="g0"');
    expect(svg).toContain('x1="0"');
    expect(svg).toContain('x2="10"');
    expect(svg).toContain('spreadMethod="repeat"');
    expect(svg).toContain('stop-color="rgb(148, 163, 184)"');
    // First and last offsets at the ends of the gradient line.
    expect(svg).toContain('offset="0"');
    expect(svg).toContain('offset="1"');
  });

  it("expands an over-line period and collapses coincident stops", () => {
    const over = buildLinearGradientDef(parseLinearGradient("repeating-linear-gradient(90deg, red 0, blue 240px)")!, "over", { x: 0, y: 0, w: 100, h: 10 });
    expect(over).toContain('x2="240"');
    expect(over).toContain('spreadMethod="repeat"');

    const solid = buildLinearGradientDef(parseLinearGradient("repeating-linear-gradient(90deg, red 8px, blue 8px)")!, "solid", { x: 0, y: 0, w: 100, h: 10 });
    expect(solid).not.toContain("spreadMethod");
    expect((solid.match(/stop-color="blue"/g) ?? []).length).toBe(2);
  });

  it("defaults omitted repeat endpoints before moving the vector", () => {
    const svg = buildLinearGradientDef(parseLinearGradient("repeating-linear-gradient(90deg, red, blue)")!, "defaulted", { x: 0, y: 0, w: 100, h: 10 });
    expect(svg).toContain('x1="0"');
    expect(svg).toContain('x2="100"');
    expect(svg).toContain('spreadMethod="repeat"');
  });

  it("non-repeating gradients still emit their two stops unchanged", () => {
    const g = parseLinearGradient("linear-gradient(90deg, red, blue)")!;
    const svg = buildLinearGradientDef(g, "g1", { x: 0, y: 0, w: 100, h: 10 });
    expect((svg.match(/<stop /g) || []).length).toBe(2);
  });

  it("normalizes negative and over-line repeat domains by moving the vector", () => {
    const negative = buildBackgroundLinearGradientDef("negative", "90deg, red -5px, blue 11px", true, 100, 70);
    expect(negative).toContain('x1="-5"');
    expect(negative).toContain('x2="11"');
    expect(negative).toContain('spreadMethod="repeat"');
    expect(negative).toContain('offset="0"');
    expect(negative).toContain('offset="1"');

    const overLine = buildBackgroundLinearGradientDef("over", "90deg, red 0, blue 240px", true, 100, 70);
    expect(overLine).toContain('x1="0"');
    expect(overLine).toContain('x2="240"');
    expect(overLine).toContain('spreadMethod="repeat"');
  });

  it("collapses a coincident repeating domain to the final color", () => {
    const svg = buildBackgroundLinearGradientDef("solid", "90deg, red 8px, blue 8px", true, 100, 70);
    expect(svg).not.toContain("spreadMethod");
    expect((svg.match(/stop-color="rgb\(0,0,255\)"/g) ?? []).length).toBe(2);
    expect(svg).not.toContain('stop-color="rgb(255,0,0)"');
  });

  it("defaults omitted repeating endpoints before normalization", () => {
    const svg = buildBackgroundLinearGradientDef("defaulted", "37deg, red, blue", true, 180, 70);
    expect(svg).toContain('spreadMethod="repeat"');
    expect(svg).toContain('offset="0"');
    expect(svg).toContain('offset="1"');
  });
});

describe("DM-2308: CSS gradient interpolation space", () => {
  it("maps opaque srgb-linear interpolation to SVG linearRGB", () => {
    const svg = buildBackgroundLinearGradientDef("g", "90deg in srgb-linear, red, blue", false, 100, 20);
    expect(svg).toContain('color-interpolation="linearRGB"');
    expect(svg).toContain('x1="0"');
    expect(svg).toContain('x2="100"');
  });

  it("maps explicit sRGB interpolation to SVG sRGB", () => {
    const svg = buildBackgroundRadialGradientDef("g", "circle in srgb, red, blue", false, 0, 0, 100, 100);
    expect(svg).toContain('color-interpolation="sRGB"');
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

describe("radial-gradient ellipse corner sizing (DM-1243)", () => {
  // buildRadialGradientDef emits r="<rx>" (the x-axis radius) + a y-scale; rx is
  // what distinguishes corner (√2·side) from the old closest-side bug. Box 300×100,
  // centered → dxFarthest=dxClosest=150, dyFarthest=dyClosest=50.
  const rect = { x: 0, y: 0, w: 300, h: 100 };
  const rxOf = (def: string): number => Number(/ r="([\d.]+)"/.exec(def)![1]);

  it("farthest-corner ellipse passes through the corner (√2·side), not the side", () => {
    const g = parseRadialGradient("radial-gradient(ellipse farthest-corner at center, red, blue)")!;
    expect(rxOf(buildRadialGradientDef(g, "fc", rect))).toBeCloseTo(Math.SQRT2 * 150, 1); // 212.13
  });

  it("closest-corner ellipse is √2·closest-side, not closest-side (the k=1 bug)", () => {
    const g = parseRadialGradient("radial-gradient(ellipse closest-corner at center, red, blue)")!;
    const rx = rxOf(buildRadialGradientDef(g, "cc", rect));
    expect(rx).toBeCloseTo(Math.SQRT2 * 150, 1); // 212.13 — NOT 150 (closest-side)
    expect(rx).not.toBeCloseTo(150, 1);
  });

  it("farthest-side ellipse stays at the side distance (unchanged)", () => {
    const g = parseRadialGradient("radial-gradient(ellipse farthest-side at center, red, blue)")!;
    expect(rxOf(buildRadialGradientDef(g, "fs", rect))).toBeCloseTo(150, 1);
  });
});
