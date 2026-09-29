import { afterEach, describe, expect, it } from "vitest";
import { backgroundPositionOffsetPx } from "./image-pattern.js";
import { buildConicGradientDef } from "./element-tree-to-svg.js";
import { _conicTileCache } from "./raster-tile-cache.js";

// Free space: a 200x100 area holding a 40x20 tile leaves 160 x 80.
const W = 160;
const H = 80;
const off = (position: string): { x: number; y: number } | null => backgroundPositionOffsetPx(position, W, H);

describe("backgroundPositionOffsetPx", () => {
  it("resolves two-token keyword, percentage and px forms against the free space", () => {
    expect(off("left top")).toEqual({ x: 0, y: 0 });
    expect(off("right bottom")).toEqual({ x: 160, y: 80 });
    expect(off("center center")).toEqual({ x: 80, y: 40 });
    expect(off("25% 50%")).toEqual({ x: 40, y: 40 });
    expect(off("10px 20px")).toEqual({ x: 10, y: 20 });
    expect(off("0% 0%")).toEqual({ x: 0, y: 0 });
  });

  it("centers the missing axis of a one-token form (the closure it replaces gave the token to both axes)", () => {
    expect(off("left")).toEqual({ x: 0, y: 40 });
    expect(off("right")).toEqual({ x: 160, y: 40 });
    expect(off("top")).toEqual({ x: 80, y: 0 });
    expect(off("bottom")).toEqual({ x: 80, y: 80 });
    expect(off("center")).toEqual({ x: 80, y: 40 });
    expect(off("30%")).toEqual({ x: 48, y: 40 });
  });

  it("accepts either axis order for keywords, and the three/four-token edge-offset forms", () => {
    expect(off("top left")).toEqual({ x: 0, y: 0 });
    expect(off("bottom right")).toEqual({ x: 160, y: 80 });
    expect(off("right 10px bottom 20px")).toEqual({ x: 150, y: 60 });
    expect(off("left 10px top 20px")).toEqual({ x: 10, y: 20 });
    expect(off("right 10px top")).toEqual({ x: 150, y: 0 });
    expect(off("left bottom 5px")).toEqual({ x: 0, y: 75 });
  });

  it("evaluates calc() the way Chrome serializes an edge-offset position", () => {
    expect(off("calc(100% - 10px) calc(100% - 20px)")).toEqual({ x: 150, y: 60 });
    expect(off("calc(50% + 5px) 0px")).toEqual({ x: 85, y: 0 });
  });

  it("allows negative free space (a tile larger than its area) and negative offsets", () => {
    expect(backgroundPositionOffsetPx("center center", -20, -10)).toEqual({ x: -10, y: -5 });
    expect(off("-10px -5px")).toEqual({ x: -10, y: -5 });
  });

  it("returns null for a value it cannot parse, and the origin for an empty one", () => {
    expect(off("banana split")).toBeNull();
    expect(off("10px 20px 30px 40px 50px")).toBeNull();
    expect(off("")).toEqual({ x: 0, y: 0 });
  });
});

describe("buildConicGradientDef places the tile through the shared resolver", () => {
  afterEach(() => _conicTileCache.clear());
  const LAYER = "conic-gradient(red, blue)";
  // A 200x100 element at (10, 20) holding a 40x20 tile.
  const origin = (position: string): { x: number; y: number } | null => {
    _conicTileCache.set(LAYER, new Map([["40x20", "data:image/png;base64,AAAA"]]));
    const def = buildConicGradientDef("p", LAYER, 10, 20, 200, 100, "40px 20px", position);
    const m = /<pattern id="p" x="(-?[\d.]+)" y="(-?[\d.]+)"/.exec(def);
    return m == null ? null : { x: Number(m[1]), y: Number(m[2]) };
  };

  it("adds the resolved offset to the element origin", () => {
    expect(origin("0% 0%")).toEqual({ x: 10, y: 20 });
    expect(origin("100% 100%")).toEqual({ x: 170, y: 100 });
    expect(origin("50% 50%")).toEqual({ x: 90, y: 60 });
    expect(origin("left top")).toEqual({ x: 10, y: 20 });
    expect(origin("right bottom")).toEqual({ x: 170, y: 100 });
  });

  it("handles a one-token position and an edge-offset position, which the private resolver got wrong", () => {
    expect(origin("left")).toEqual({ x: 10, y: 60 });
    expect(origin("top")).toEqual({ x: 90, y: 20 });
    expect(origin("right 10px bottom 20px")).toEqual({ x: 160, y: 80 });
    expect(origin("calc(100% - 10px) 0px")).toEqual({ x: 160, y: 20 });
  });

  it("keeps the top-left origin for a position it cannot parse, and emits nothing on a cache miss", () => {
    expect(origin("nonsense")).toEqual({ x: 10, y: 20 });
    _conicTileCache.clear();
    expect(buildConicGradientDef("p", LAYER, 10, 20, 200, 100, "40px 20px", "0% 0%")).toBe("");
  });
});
