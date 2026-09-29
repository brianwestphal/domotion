import { afterEach, describe, expect, it } from "vitest";
import { elementTreeToSvg } from "../render/element-tree-to-svg.js";
import { rasterizeConicGradients } from "../render/conic-raster.js";
import { _advancedGradientTileCache, _conicTileCache } from "../render/raster-tile-cache.js";
import { _dataUriCache, _resizedDataUriCache } from "./embed.js";
import { clearCaptureGenerationCaches } from "./generation-caches.js";

const LAYER = "repeating-conic-gradient(#ddd 0 25%, white 0 50%)";
const STALE = "data:image/png;base64,c3RhbGU=";
const tree = (): any => [
  {
    tag: "div",
    tagName: "div",
    text: "",
    x: 0,
    y: 0,
    width: 24,
    height: 24,
    styles: {
      backgroundImage: LAYER,
      backgroundSize: "24px 24px",
      backgroundColor: "transparent",
      color: "black",
      borderColor: "transparent",
    },
    children: [],
  },
];

afterEach(() => {
  clearCaptureGenerationCaches();
});

describe("clearCaptureGenerationCaches", () => {
  it("empties every capture-generation cache", () => {
    _conicTileCache.set("a", new Map([["1x1", "x"]]));
    _advancedGradientTileCache.set("b", new Map([["1x1", "y"]]));
    _dataUriCache.set("u", "d");
    _resizedDataUriCache.set("u", new Map([["1x1", "r"]]));
    clearCaptureGenerationCaches();
    expect([
      _conicTileCache.size,
      _advancedGradientTileCache.size,
      _dataUriCache.size,
      _resizedDataUriCache.size,
    ]).toEqual([0, 0, 0, 0]);
  });

  it("is what lets a second document repaint a layer the first document left behind", async () => {
    // A rasterizer never overwrites an existing key, so without the reset the first
    // document's tile (here a stand-in for a CPU approximation) answers forever.
    _conicTileCache.set(LAYER, new Map([["24x24", STALE]]));
    await rasterizeConicGradients(tree(), { hiDPIFactor: 2 });
    expect(_conicTileCache.get(LAYER)?.get("24x24")).toBe(STALE);

    clearCaptureGenerationCaches();
    await rasterizeConicGradients(tree(), { hiDPIFactor: 2 });
    const fresh = _conicTileCache.get(LAYER)?.get("24x24");
    expect(fresh?.startsWith("data:image/png;base64,")).toBe(true);
    expect(fresh).not.toBe(STALE);
  });

  it("is safe to call repeatedly and on empty caches", () => {
    clearCaptureGenerationCaches();
    clearCaptureGenerationCaches();
    expect(_conicTileCache.size).toBe(0);
  });

  it("renders a tree byte-identically twice in one generation, and again after a reset", async () => {
    const t = tree();
    await rasterizeConicGradients(t, { hiDPIFactor: 2 });
    const first = elementTreeToSvg(t, 24, 24);
    expect(elementTreeToSvg(t, 24, 24)).toBe(first);

    clearCaptureGenerationCaches();
    await rasterizeConicGradients(t, { hiDPIFactor: 2 });
    expect(elementTreeToSvg(t, 24, 24)).toBe(first);
  });
});
