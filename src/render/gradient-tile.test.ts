import { describe, expect, it } from "vitest";
import { buildGradientTilePatternDef } from "./gradient-tile.js";

// DM-8F20GA: gradient layers tile with Blink's background geometry; the old
// single stretched gradient stays byte-stable only where it is equivalent.
const base = {
  id: "bg0",
  kind: "linear" as const,
  args: "red, blue",
  repeating: false,
  positioningArea: { x: 10, y: 10, width: 100, height: 100 },
  paintingArea: { x: 10, y: 10, width: 100, height: 100 },
  size: "auto",
  position: "0% 0%",
  repeat: "repeat",
};

describe("buildGradientTilePatternDef", () => {
  it("keeps the single-gradient path when one tile is the positioning area and covers the paint", () => {
    expect(buildGradientTilePatternDef(base)).toBeNull();
    expect(buildGradientTilePatternDef({ ...base, paintingArea: null })).toBeNull();
    // Sub-pixel snapping alone does not switch paths.
    expect(
      buildGradientTilePatternDef({
        ...base,
        positioningArea: { x: 10.3, y: 10.3, width: 100, height: 100 },
        paintingArea: { x: 10.3, y: 10.3, width: 100, height: 100 },
      }),
    ).toBeNull();
  });

  it("tiles an explicit size from the resolved tile origin", () => {
    const def = buildGradientTilePatternDef({ ...base, size: "100px 50px" })!;
    expect(def).toMatch(/^<linearGradient id="bg0t"/);
    expect(def).toContain('<pattern id="bg0" patternUnits="userSpaceOnUse" x="10" y="10" width="100" height="50">');
    expect(def).toContain('fill="url(#bg0t)"');
  });

  it("omits a gradient whose resolved tile has zero area inside a painted canvas", () => {
    const positioningArea = { ...base.positioningArea, height: 0 };
    expect(buildGradientTilePatternDef({ ...base, positioningArea })).toBe("");
    expect(buildGradientTilePatternDef({ ...base, positioningArea, size: "10px 10px" })).toContain("<pattern");
  });

  it("repeats an auto-sized tile into a larger painting area (border box)", () => {
    const def = buildGradientTilePatternDef({ ...base, paintingArea: { x: 0, y: 0, width: 120, height: 120 } })!;
    // Tile phase 10 px modulo the 100 px step, starting at the painting area.
    const match = /<pattern [^>]*x="(-?[\d.]+)" y="(-?[\d.]+)" width="100" height="100"/.exec(def);
    expect(match).not.toBeNull();
    expect((((Number(match![1]) - 10) % 100) + 100) % 100).toBe(0);
    expect((((Number(match![2]) - 10) % 100) + 100) % 100).toBe(0);
    expect(Number(match![1])).toBeLessThanOrEqual(0);
  });

  it("ignores a repeat confined to a band an opaque border covers", () => {
    const paintingArea = { x: 0, y: 0, width: 120, height: 120 };
    expect(
      buildGradientTilePatternDef({
        ...base,
        paintingArea,
        visiblePaintingArea: { x: 10, y: 10, width: 100, height: 100 },
      }),
    ).toBeNull();
    // A partly covered band still shows the repeat.
    expect(
      buildGradientTilePatternDef({
        ...base,
        paintingArea,
        visiblePaintingArea: { x: 5, y: 10, width: 105, height: 100 },
      }),
    ).not.toBeNull();
  });

  it("paints a no-repeat tile once inside a painting-area-sized pattern", () => {
    const def = buildGradientTilePatternDef({
      ...base,
      kind: "radial",
      args: "circle, red 40%, blue 41%",
      size: "40px 40px",
      position: "center",
      repeat: "no-repeat",
    })!;
    expect(def).toMatch(/^<radialGradient id="bg0t"/);
    expect(def).toContain('<pattern id="bg0" patternUnits="userSpaceOnUse" x="10" y="10" width="100" height="100">');
    expect(def).toContain('<rect x="30" y="30" width="40" height="40"');
  });

  it("returns null for geometry it cannot resolve", () => {
    expect(buildGradientTilePatternDef({ ...base, repeat: "sideways" })).toBeNull();
  });
});
