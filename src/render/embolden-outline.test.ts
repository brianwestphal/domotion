import { describe, expect, it } from "vitest";
import {
  FAUX_BOLD_WEIGHT_DELTA,
  OBLIQUE_SHEAR,
  resolveFakeBoldTextPaint,
  shearPathCommands,
  skiaFakeBoldStrokeExtraPx,
} from "./embolden-outline.js";
import type { PathCommand } from "./embedded-font-builder.js";

describe("skiaFakeBoldStrokeExtraPx", () => {
  it("transcribes SkTextFormatParams' two knees and interpolated scale", () => {
    expect(skiaFakeBoldStrokeExtraPx(6)).toBeCloseTo(6 / 24, 8);
    expect(skiaFakeBoldStrokeExtraPx(9)).toBeCloseTo(9 / 24, 8);
    expect(skiaFakeBoldStrokeExtraPx(22.5)).toBeCloseTo(22.5 * ((1 / 24 + 1 / 32) / 2), 8);
    expect(skiaFakeBoldStrokeExtraPx(36)).toBeCloseTo(36 / 32, 8);
    expect(skiaFakeBoldStrokeExtraPx(72)).toBeCloseTo(72 / 32, 8);
  });
});

describe("resolveFakeBoldTextPaint", () => {
  const base = {
    strokeWidthPx: 2,
    strokeFirst: false,
    fillIsTransparent: false,
    faceLacksWeight: true,
    fontSizePx: 72,
  };

  it("keeps the source outline and records Skia's fill/stroke scaler stages", () => {
    const plan = resolveFakeBoldTextPaint(base);
    expect(plan.outline).toBe("source");
    expect(plan.extraPx).toBeCloseTo(2.25, 8);
    expect(plan.stages).toEqual([
      { paint: "fill", frameWidthPx: 2.25, frameAndFill: true, visible: true },
      { paint: "stroke", frameWidthPx: 4.25, frameAndFill: false, visible: true },
    ]);
    expect(plan.svgPasses).toEqual([{
      kind: "combined",
      fill: "source",
      stroke: "author",
      strokeWidthPx: 4.25,
    }]);
  });

  it("preserves opaque stroke-first as two differently coloured passes", () => {
    const plan = resolveFakeBoldTextPaint({ ...base, strokeFirst: true });
    expect(plan.stages).toEqual([
      { paint: "stroke", frameWidthPx: 4.25, frameAndFill: false, visible: true },
      { paint: "fill", frameWidthPx: 2.25, frameAndFill: true, visible: true },
    ]);
    expect(plan.svgPasses).toEqual([
      { kind: "author-stroke", fill: "none", stroke: "author", strokeWidthPx: 4.25 },
      { kind: "synthetic-fill", fill: "source", stroke: "source-fill", strokeWidthPx: 2.25 },
    ]);
  });

  it("coalesces transparent stroke-first because the hidden fill frame cannot contribute", () => {
    const plan = resolveFakeBoldTextPaint({ ...base, strokeFirst: true, fillIsTransparent: true });
    expect(plan.stages[1]).toEqual({
      paint: "fill", frameWidthPx: 2.25, frameAndFill: true, visible: false,
    });
    expect(plan.svgPasses).toEqual([{
      kind: "combined",
      fill: "source",
      stroke: "author",
      strokeWidthPx: 4.25,
      paintOrder: "stroke fill",
    }]);
  });

  it("represents an unstroked synthetic fill as source fill plus its frame", () => {
    const plan = resolveFakeBoldTextPaint({ ...base, strokeWidthPx: 0 });
    expect(plan.stages).toEqual([
      { paint: "fill", frameWidthPx: 2.25, frameAndFill: true, visible: true },
    ]);
    expect(plan.svgPasses).toEqual([{
      kind: "combined", fill: "source", stroke: "source-fill", strokeWidthPx: 2.25,
    }]);
  });

  it("does not synthesize a static/variable face that already satisfies weight", () => {
    const plan = resolveFakeBoldTextPaint({ ...base, faceLacksWeight: false });
    expect(plan.extraPx).toBe(0);
    expect(plan.outline).toBe("source");
    expect(plan.stages).toEqual([
      { paint: "fill", frameWidthPx: -1, frameAndFill: false, visible: true },
      { paint: "stroke", frameWidthPx: 2, frameAndFill: false, visible: true },
    ]);
    expect(plan.svgPasses[0]).toEqual({
      kind: "combined", fill: "source", stroke: "author", strokeWidthPx: 2,
    });
  });

  it("uses identical source-owned scaler records on all Chromium desktop backends", () => {
    const plans = (["darwin", "linux", "win32"] as const).map((platform) =>
      resolveFakeBoldTextPaint({ ...base, strokeFirst: true, platform }));
    for (const plan of plans) {
      expect(plan.outline).toBe("source");
      expect(plan.stages).toEqual(plans[0].stages);
      expect(plan.svgPasses).toEqual(plans[0].svgPasses);
    }
  });

  it("mutation control: a retired derived-outline branch changes the exact record", () => {
    const sourcePlan = resolveFakeBoldTextPaint({ ...base, strokeFirst: true });
    const retiredMutation = {
      ...sourcePlan,
      outline: "derived-outline",
      svgPasses: [sourcePlan.svgPasses[0]],
    };
    expect(retiredMutation).not.toEqual(sourcePlan);
    expect(sourcePlan.outline).toBe("source");
    expect(sourcePlan.svgPasses).toHaveLength(2);
  });
});

describe("shearPathCommands (faux-italic)", () => {
  const glyph: PathCommand[] = [
    { command: "moveTo", args: [0, 0] },
    { command: "lineTo", args: [0, 100] },
    { command: "quadraticCurveTo", args: [10, 200, 40, 0] },
    { command: "closePath", args: [] },
  ];

  it("returns the input unchanged for factor zero", () => {
    expect(shearPathCommands(glyph, 0)).toBe(glyph);
  });

  it("shears x around the baseline without mutating the source", () => {
    const snapshot = JSON.stringify(glyph);
    const out = shearPathCommands(glyph, OBLIQUE_SHEAR);
    expect(out[0].args).toEqual([0, 0]);
    expect(out[1].args).toEqual([25, 100]);
    expect(out[2].args).toEqual([60, 200, 40, 0]);
    expect(JSON.stringify(glyph)).toBe(snapshot);
  });
});

describe("FAUX_BOLD_WEIGHT_DELTA", () => {
  it("keeps the generic Blink selection threshold source-owned", () => {
    expect(700 - 500).not.toBeGreaterThan(FAUX_BOLD_WEIGHT_DELTA);
    expect(800 - 500).toBeGreaterThan(FAUX_BOLD_WEIGHT_DELTA);
  });
});
