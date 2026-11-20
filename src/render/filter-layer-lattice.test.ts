import { describe, expect, it } from "vitest";
import { capturedElement, capturedStyles } from "../test-support/captured-fixtures.js";
import type { CapturedElement, CapturedTextPaintAffine } from "../capture/types.js";
import { buildFilterLayerBasisMap, filterLayerParameterOrigin, formatTranslation } from "./filter-layer-lattice.js";

const rotate10: CapturedTextPaintAffine = [0.98481, 0.17365, -0.17365, 0.98481, 0, 0];
const box = (
  x: number,
  y: number,
  styles: Parameters<typeof capturedStyles>[0],
  children: CapturedElement[] = [],
): CapturedElement => capturedElement({ x, y, width: 70, height: 36, styles: capturedStyles(styles), children });

describe("filter layer parameter space", () => {
  it("records the nearest transformed box and the folded rounding enclosing it", () => {
    const leaf = box(45, 25.3, {});
    const inner = box(44.5, 24.75, { transform: "matrix(1, 0, 0, 1, 3, 0)" }, [leaf]);
    const outer = box(
      40,
      20.4375,
      { transform: "matrix(0.98481, 0.17365, -0.17365, 0.98481, 0, 0)", transformPaintShift: [0, -0.4375] },
      [inner],
    );
    const plain = box(0, 0, {}, [box(1, 1, {})]);
    const map = buildFilterLayerBasisMap([outer, plain]);
    expect(map.get(outer)).toEqual({ transformBox: [40, 20.4375], paintShiftSum: [0, -0.4375] });
    expect(map.get(inner)).toEqual({ transformBox: [44.5, 24.75], paintShiftSum: [0, -0.4375] });
    expect(map.get(leaf)).toEqual({ transformBox: [44.5, 24.75], paintShiftSum: [0, -0.4375] });
    // Outside every transform there is no local space to restore.
    expect(map.get(plain)).toBeUndefined();
    expect(map.get(plain.children[0])).toBeUndefined();
  });

  it("moves a unit-scale grid by the smallest congruent translation", () => {
    // A rotation's layer matrix is the identity, so only the grid phase matters.
    expect(filterLayerParameterOrigin(rotate10, { transformBox: [40, 20.4375], paintShiftSum: [0, -0.4375] })).toEqual([
      0, 0.4375,
    ]);
    expect(filterLayerParameterOrigin(rotate10, { transformBox: [40, 20], paintShiftSum: [0, 0] })).toBeNull();
    // A translation that kept its accumulation under a fractional rotated
    // ancestor stays on the ancestor's grid.
    expect(filterLayerParameterOrigin(rotate10, { transformBox: [44.5, 24.75], paintShiftSum: [0, -0.4375] })).toEqual([
      0, 0.4375,
    ]);
  });

  it("puts a scaled grid at Blink's exact local origin", () => {
    const rotateScale: CapturedTextPaintAffine = [1.477215, 0.260475, -0.260475, 1.477215, 0, 0];
    expect(
      filterLayerParameterOrigin(rotateScale, { transformBox: [40, 20.4375], paintShiftSum: [0, -0.4375] }),
    ).toEqual([40, 20.4375]);
    expect(filterLayerParameterOrigin(rotateScale, { transformBox: [40, 20], paintShiftSum: [0, 0] })).toEqual([
      40, 20,
    ]);
    // Inside a transform that kept its accumulation, the local origin is on the
    // enclosing grid within half a pixel of the box.
    expect(
      filterLayerParameterOrigin(rotateScale, { transformBox: [44.5, 24.75], paintShiftSum: [0, -0.4375] }),
    ).toEqual([44, 24.4375]);
    // skewX keeps a unit x column and lengthens the y column.
    expect(
      filterLayerParameterOrigin([1, 0, 0.21256, 1, 0, 0], { transformBox: [12.25, 7.5], paintShiftSum: [-0.25, 0.5] }),
    ).toEqual([0.25, 7.5]);
  });

  it("leaves scale+translate CTMs, unknown CTMs and untransformed content alone", () => {
    const basis = { transformBox: [40, 20.4375] as [number, number], paintShiftSum: [0, -0.4375] as [number, number] };
    // Skia keeps a scale+translate CTM as the layer matrix, so the layer is device space.
    expect(filterLayerParameterOrigin([1.5, 0, 0, 1.5, 3, 4], basis)).toBeNull();
    expect(filterLayerParameterOrigin(null, basis)).toBeNull();
    expect(filterLayerParameterOrigin(rotate10, undefined)).toBeNull();
    expect(filterLayerParameterOrigin(rotate10, { transformBox: [0, 0], paintShiftSum: [0, 0] })).toBeNull();
  });

  it("formats the 1/64 grid exactly", () => {
    expect(formatTranslation([40, 20.4375])).toBe("translate(40 20.4375)");
    expect(formatTranslation([-0.015625, -0])).toBe("translate(-0.015625 0)");
  });
});
