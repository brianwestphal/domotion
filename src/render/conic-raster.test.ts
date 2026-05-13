import { describe, expect, it } from "vitest";
import { rasterizeConic, resolveConicStops } from "./conic-raster.js";
import { parseConicGradient } from "./gradients.js";

function pixel(buf: Buffer, w: number, x: number, y: number): { r: number; g: number; b: number; a: number } {
  const i = (y * w + x) * 4;
  return { r: buf[i], g: buf[i + 1], b: buf[i + 2], a: buf[i + 3] };
}

describe("resolveConicStops (DM-549)", () => {
  it("auto-distributes stops without explicit positions", () => {
    const g = parseConicGradient("conic-gradient(red, yellow, green, blue)");
    const stops = resolveConicStops(g!.stops);
    expect(stops).toHaveLength(4);
    expect(stops[0].offset).toBe(0);
    expect(stops[1].offset).toBeCloseTo(1 / 3);
    expect(stops[2].offset).toBeCloseTo(2 / 3);
    expect(stops[3].offset).toBe(1);
  });

  it("preserves explicit angle positions", () => {
    const g = parseConicGradient("conic-gradient(red 0deg, yellow 90deg, blue 180deg)");
    const stops = resolveConicStops(g!.stops);
    expect(stops[0].offset).toBe(0);
    expect(stops[1].offset).toBe(0.25);
    expect(stops[2].offset).toBe(0.5);
  });

  it("emits hard stops as adjacent positions with same offset boundary", () => {
    const g = parseConicGradient("conic-gradient(red 0% 25%, blue 25% 50%)");
    const stops = resolveConicStops(g!.stops);
    expect(stops).toHaveLength(4);
    // The two middle stops both sit at 0.25.
    expect(stops[1].offset).toBe(0.25);
    expect(stops[2].offset).toBe(0.25);
  });
});

describe("rasterizeConic: smooth color sweep (DM-549)", () => {
  const g = parseConicGradient("conic-gradient(red, blue)")!;
  const w = 32, h = 32;
  const buf = rasterizeConic(g, w, h);

  it("produces a non-empty buffer of the right size", () => {
    expect(buf.length).toBe(w * h * 4);
  });

  it("paints pure red at the top center (sweep origin)", () => {
    // Just below the top edge at center x → angle ≈ 0 → first stop = red.
    const px = pixel(buf, w, 16, 0);
    expect(px.r).toBeGreaterThan(240);
    expect(px.g).toBeLessThan(20);
    expect(px.b).toBeLessThan(20);
    expect(px.a).toBe(255);
  });

  it("paints pure red at the bottom center too (last stop wraps to first)", () => {
    // The non-repeating gradient has only two stops (red at 0, blue at 1).
    // At the bottom-center (angle ≈ 180°) we're at fraction 0.5 — that's
    // the midpoint between red and blue, not pure red.
    const px = pixel(buf, w, 16, h - 1);
    // Halfway between rgb(255,0,0) and rgb(0,0,255) is rgb(128,0,128).
    expect(px.r).toBeGreaterThan(100);
    expect(px.r).toBeLessThan(160);
    expect(px.b).toBeGreaterThan(100);
    expect(px.b).toBeLessThan(160);
  });
});

describe("rasterizeConic: hard-stop checkerboard (DM-549, the canonical case)", () => {
  // The 19-deep-color-mix tile: `repeating-conic-gradient(#ddd 0 25%, white 0 50%) 0/24px 24px`
  // produces a four-quadrant alternating tile. We rasterize a 24×24 tile.
  const g = parseConicGradient("repeating-conic-gradient(#ddd 0 25%, white 0 50%)")!;
  const w = 24, h = 24;
  const buf = rasterizeConic(g, w, h);

  it("top-right quadrant (12 → 3 o'clock sweep, 0..25%) is #ddd", () => {
    const px = pixel(buf, w, 18, 6);
    // #ddd = rgb(221, 221, 221)
    expect(px.r).toBe(221);
    expect(px.g).toBe(221);
    expect(px.b).toBe(221);
  });

  it("bottom-right quadrant (3 → 6 o'clock sweep, 25..50%) is white", () => {
    const px = pixel(buf, w, 18, 18);
    expect(px.r).toBe(255);
    expect(px.g).toBe(255);
    expect(px.b).toBe(255);
  });

  it("bottom-left quadrant (6 → 9 o'clock sweep, 50..75% wraps to #ddd) is #ddd", () => {
    // Repeating period is 50% (one #ddd quadrant + one white quadrant), so
    // the 50..75% sweep wraps back to #ddd.
    const px = pixel(buf, w, 6, 18);
    expect(px.r).toBe(221);
    expect(px.g).toBe(221);
    expect(px.b).toBe(221);
  });

  it("top-left quadrant (9 → 12 o'clock sweep, 75..100% wraps to white) is white", () => {
    const px = pixel(buf, w, 6, 6);
    expect(px.r).toBe(255);
    expect(px.g).toBe(255);
    expect(px.b).toBe(255);
  });
});

describe("rasterizeConic: from <angle> rotates the origin (DM-549)", () => {
  const g = parseConicGradient("conic-gradient(from 90deg, red 0% 25%, blue 25% 50%)")!;
  const w = 32, h = 32;
  const buf = rasterizeConic(g, w, h);

  it("with from=90deg, the red 0..25% wedge sits at 3-6 o'clock (right side, going down)", () => {
    // CSS `from 90deg` shifts the sweep origin 90deg clockwise from the top:
    //   0%  → 3 o'clock (right)
    //   25% → 6 o'clock (bottom)
    // The red wedge spans 0..25%, so a point at the right edge slightly
    // below center sits at frac ≈ 0.0..0.125 — pure red.
    const px = pixel(buf, w, w - 1, h / 2 + 2);
    expect(px.r).toBeGreaterThan(240);
    expect(px.b).toBeLessThan(20);
  });

  it("with from=90deg, the top-center is past the 50% boundary (clamped to blue)", () => {
    // Top-center: angle ≈ 0deg from north. After from=90deg shift: frac ≈ 0.75.
    // Past the last stop (0.5) → clamps to blue.
    const px = pixel(buf, w, w / 2, 1);
    expect(px.b).toBeGreaterThan(240);
    expect(px.r).toBeLessThan(20);
  });
});

describe("rasterizeConicGradients pre-pass + buildConicGradientDef end-to-end (DM-549/550)", () => {
  it("populates the conic tile cache and the renderer emits <pattern><image>", async () => {
    const { rasterizeConicGradients } = await import("./conic-raster.js");
    const { _conicTileCache } = await import("./element-tree-to-svg.js");
    _conicTileCache.clear();

    // Minimal captured-tree shape with a conic-gradient bg layer.
    const tree: any = [{
      tagName: "div",
      x: 0, y: 0, width: 24, height: 24,
      styles: {
        backgroundImage: "repeating-conic-gradient(#ddd 0 25%, white 0 50%)",
        backgroundSize: "24px 24px",
      },
      children: [],
    }];

    await rasterizeConicGradients(tree as any, { hiDPIFactor: 2 });

    const layer = "repeating-conic-gradient(#ddd 0 25%, white 0 50%)";
    const sizeCache = _conicTileCache.get(layer);
    expect(sizeCache).toBeDefined();
    expect(sizeCache!.has("24x24")).toBe(true);
    const dataUri = sizeCache!.get("24x24")!;
    expect(dataUri.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("dedupes (layerText, tileSize) tuples — multiple consumers share one cache entry", async () => {
    const { rasterizeConicGradients } = await import("./conic-raster.js");
    const { _conicTileCache } = await import("./element-tree-to-svg.js");
    _conicTileCache.clear();

    const layer = "conic-gradient(red, blue)";
    // Three sibling elements all painting the same conic.
    const tree: any = [
      { tagName: "div", x: 0, y: 0, width: 100, height: 100, styles: { backgroundImage: layer }, children: [] },
      { tagName: "div", x: 0, y: 100, width: 100, height: 100, styles: { backgroundImage: layer }, children: [] },
      { tagName: "div", x: 0, y: 200, width: 100, height: 100, styles: { backgroundImage: layer }, children: [] },
    ];
    await rasterizeConicGradients(tree as any, { hiDPIFactor: 2 });
    const sizeCache = _conicTileCache.get(layer);
    // All three consumers have the same rect (100×100, default size=auto so
    // tile == element) — cache should have exactly one entry.
    expect(sizeCache?.size).toBe(1);
    expect(sizeCache?.has("100x100")).toBe(true);
  });

  it("skips trees with no conic content (no cache pollution)", async () => {
    const { rasterizeConicGradients } = await import("./conic-raster.js");
    const { _conicTileCache } = await import("./element-tree-to-svg.js");
    _conicTileCache.clear();

    const tree: any = [{
      tagName: "div",
      x: 0, y: 0, width: 100, height: 100,
      styles: {
        backgroundImage: "linear-gradient(red, blue)",
      },
      children: [],
    }];
    await rasterizeConicGradients(tree as any, { hiDPIFactor: 2 });
    expect(_conicTileCache.size).toBe(0);
  });
});

describe("rasterizeConic: at <position> moves the center (DM-549)", () => {
  const g = parseConicGradient("conic-gradient(at 0% 0%, red, blue)")!;
  const w = 32, h = 32;
  const buf = rasterizeConic(g, w, h);

  it("with center at (0,0), the bottom-right is far from origin and blends red→blue", () => {
    // Bottom-right pixel: angle from (0,0) is 135° measured from screen-down.
    // That's frac ≈ 0.375 in the conic sweep (from-top, clockwise) which lies
    // in the red→blue interpolation.
    const px = pixel(buf, w, w - 1, h - 1);
    // Should be a mix, neither pure red nor pure blue.
    expect(px.r).toBeGreaterThan(60);
    expect(px.b).toBeGreaterThan(60);
  });
});
