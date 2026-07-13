import { describe, it, expect } from "vitest";
import { emboldenPathCommands, emboldenStrengthForFont, FAUX_BOLD_WEIGHT_DELTA } from "./embolden-outline.js";
import type { PathCommand } from "./embedded-font-builder.js";

/** Axis-aligned bounding box of a command list's coordinate pairs. */
function bbox(cmds: PathCommand[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of cmds) {
    for (let i = 0; i + 1 < c.args.length; i += 2) {
      minX = Math.min(minX, c.args[i]); maxX = Math.max(maxX, c.args[i]);
      minY = Math.min(minY, c.args[i + 1]); maxY = Math.max(maxY, c.args[i + 1]);
    }
  }
  return { w: maxX - minX, h: maxY - minY, minX, minY, maxX, maxY };
}

/** Shoelace area of a single closed contour (abs). */
function area(cmds: PathCommand[]): number {
  const pts: Array<[number, number]> = [];
  for (const c of cmds) {
    if (c.command === "moveTo" || c.command === "lineTo") pts.push([c.args[0], c.args[1]]);
  }
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a / 2);
}

const square = (s: number): PathCommand[] => [
  { command: "moveTo", args: [0, 0] },
  { command: "lineTo", args: [s, 0] },
  { command: "lineTo", args: [s, s] },
  { command: "lineTo", args: [0, s] },
  { command: "closePath", args: [] },
];

describe("emboldenStrengthForFont", () => {
  it("is 0.73 * upem/24 (calibrated to Chrome's painted ink)", () => {
    expect(emboldenStrengthForFont(1000)).toBeCloseTo((1000 / 24) * 0.73, 6);
    expect(emboldenStrengthForFont(2048)).toBeCloseTo((2048 / 24) * 0.73, 6);
  });
  it("scales linearly with unitsPerEm (constant dilation is size-independent)", () => {
    expect(emboldenStrengthForFont(2000) / emboldenStrengthForFont(1000)).toBeCloseTo(2, 6);
  });
});

describe("emboldenPathCommands", () => {
  it("returns the input unchanged for strength <= 0", () => {
    const cmds = square(100);
    expect(emboldenPathCommands(cmds, 0)).toBe(cmds);
    expect(emboldenPathCommands(cmds, -5)).toBe(cmds);
  });

  it("returns the input unchanged for empty commands", () => {
    expect(emboldenPathCommands([], 20)).toEqual([]);
  });

  it("does not mutate the source outline", () => {
    const cmds = square(100);
    const snapshot = JSON.stringify(cmds);
    emboldenPathCommands(cmds, 20);
    expect(JSON.stringify(cmds)).toBe(snapshot);
  });

  it("grows a filled contour outward (bbox + area both increase)", () => {
    const before = square(100);
    const after = emboldenPathCommands(before, 20);
    const b = bbox(before), a = bbox(after);
    expect(a.w).toBeGreaterThan(b.w);
    expect(a.h).toBeGreaterThan(b.h);
    expect(area(after)).toBeGreaterThan(area(before));
    // A ~10px-per-side dilation on a 100px square grows each dimension by roughly
    // the strength — sanity-bound it well away from 0 and from absurd blowup.
    expect(a.w - b.w).toBeGreaterThan(5);
    expect(a.w - b.w).toBeLessThan(60);
  });

  it("emits integer coordinates (glyf outlines are integer font units)", () => {
    const after = emboldenPathCommands(square(100), 17);
    for (const c of after) for (const v of c.args) expect(Number.isInteger(v)).toBe(true);
  });

  it("is deterministic (same input → identical output)", () => {
    const a = emboldenPathCommands(square(100), 20);
    const b = emboldenPathCommands(square(100), 20);
    expect(a).toEqual(b);
  });

  it("shrinks an interior counter (hole) while growing the outer contour → more ink", () => {
    // Outer 200-square (CCW) + inner 100-square hole (CW winding). After embolden
    // the outer grows and the hole shrinks, so the filled ring area increases.
    const glyph: PathCommand[] = [
      { command: "moveTo", args: [0, 0] },
      { command: "lineTo", args: [200, 0] },
      { command: "lineTo", args: [200, 200] },
      { command: "lineTo", args: [0, 200] },
      { command: "closePath", args: [] },
      // hole, opposite winding
      { command: "moveTo", args: [50, 50] },
      { command: "lineTo", args: [50, 150] },
      { command: "lineTo", args: [150, 150] },
      { command: "lineTo", args: [150, 50] },
      { command: "closePath", args: [] },
    ];
    const after = emboldenPathCommands(glyph, 20);
    const outerBefore = bbox(glyph.slice(0, 5));
    const outerAfter = bbox(after.slice(0, 5));
    expect(outerAfter.w).toBeGreaterThan(outerBefore.w); // outer grew
    // hole (commands 5..8) got smaller
    const holeBefore = bbox(glyph.slice(5, 9));
    const holeAfter = bbox(after.slice(5, 9));
    expect(holeAfter.w).toBeLessThan(holeBefore.w);
  });

  it("preserves command structure (same commands, curves keep their arity)", () => {
    const cmds: PathCommand[] = [
      { command: "moveTo", args: [0, 0] },
      { command: "quadraticCurveTo", args: [50, 100, 100, 0] },
      { command: "bezierCurveTo", args: [120, 20, 120, 80, 100, 100] },
      { command: "lineTo", args: [0, 100] },
      { command: "closePath", args: [] },
    ];
    const after = emboldenPathCommands(cmds, 15);
    expect(after.map((c) => c.command)).toEqual(cmds.map((c) => c.command));
    expect(after.map((c) => c.args.length)).toEqual(cmds.map((c) => c.args.length));
  });
});

describe("FAUX_BOLD_WEIGHT_DELTA", () => {
  it("excludes the corpus-wide weight-700 headers on a 500-face (Δ200) but includes 800 (Δ300)", () => {
    expect(700 - 500).not.toBeGreaterThan(FAUX_BOLD_WEIGHT_DELTA);
    expect(800 - 500).toBeGreaterThan(FAUX_BOLD_WEIGHT_DELTA);
  });
});
