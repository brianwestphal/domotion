import { describe, expect, it } from "vitest";
import {
  deriveSvgAffineFreeze,
  multiplySvgAffine,
  serializeSvgAffine,
  svgAffineMaxPointError,
  type SvgAffineMatrix,
} from "./svg-affine-freeze.js";

const IDENTITY: SvgAffineMatrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

describe("Blink-used inline SVG affine freeze (DM-2473)", () => {
  it("expresses an ordinary graphics CTM relative to its SVG parent", () => {
    const parent = { ...IDENTITY, e: 7, f: 9 };
    const local = { a: 0.8, b: 0.2, c: -0.1, d: 1.1, e: 13, f: -4 };
    const used = multiplySvgAffine(parent, local);
    const freeze = deriveSvgAffineFreeze(used, parent, parent);
    expect(freeze).not.toBeNull();
    expect(svgAffineMaxPointError(freeze!.frozen, local)).toBeLessThan(1e-12);
  });

  it("removes a nested viewport's intrinsic x/y and viewBox mapping before serialization", () => {
    // Fresh Chromium discriminator: the nested SVG retains N =
    // matrix(10 0 0 5 20 30). Its used local matrix includes that viewport
    // mapping after the authored rotate/origin transform.
    const parent = { ...IDENTITY, e: 7, f: 9 };
    const neutralLocal = { a: 10, b: 0, c: 0, d: 5, e: 20, f: 30 };
    const frozen = {
      a: 0.9396926207859085,
      b: 0.3420201433256687,
      c: -0.3420201433256687,
      d: 0.9396926207859085,
      e: 43.24812121468062,
      f: -45.272283577441165,
    };
    const usedLocal = multiplySvgAffine(frozen, neutralLocal);
    const freeze = deriveSvgAffineFreeze(
      multiplySvgAffine(parent, usedLocal),
      parent,
      multiplySvgAffine(parent, neutralLocal),
    );
    expect(freeze).not.toBeNull();
    expect(svgAffineMaxPointError(freeze!.frozen, frozen)).toBeLessThan(1e-12);
    expect(svgAffineMaxPointError(freeze!.usedLocal, usedLocal)).toBeLessThan(1e-12);
    // The mutation that writes usedLocal directly would apply N twice.
    expect(svgAffineMaxPointError(freeze!.usedLocal, freeze!.frozen)).toBeGreaterThan(10);
  });

  it("serializes six finite 2D values exactly and never emits matrix3d syntax", () => {
    const matrix = { a: -0, b: 1e-7, c: -2.5, d: 1, e: 9007199254740991, f: -3.25 };
    const serialized = serializeSvgAffine(matrix);
    expect(serialized).toBe("matrix(0 1e-7 -2.5 1 9007199254740991 -3.25)");
    expect(serialized).not.toContain("matrix3d");
  });

  it("fails closed for singular, unavailable, and non-finite correlations", () => {
    const singular = { a: 1, b: 2, c: 2, d: 4, e: 0, f: 0 };
    expect(deriveSvgAffineFreeze(singular, IDENTITY, IDENTITY)).toBeNull();
    expect(deriveSvgAffineFreeze(IDENTITY, singular, IDENTITY)).toBeNull();
    expect(deriveSvgAffineFreeze(IDENTITY, IDENTITY, singular)).toBeNull();
    expect(deriveSvgAffineFreeze({ ...IDENTITY, e: Number.NaN }, IDENTITY, IDENTITY)).toBeNull();
  });

  it("rejects the apparent six-entry 2D submatrix mutation for a flattened 3D origin", () => {
    // Blink's flattened rotateY(47deg) around an asymmetric x/y/z origin has a
    // source-owned translation. Selecting m11/m12/m21/m22/m41/m42 from the
    // computed matrix3d loses that translation even though both are affine.
    const blinkUsed = { a: 0.6819983600624985, b: 0, c: 0, d: 1, e: 11.130057397812553, f: -3.75 };
    const apparentSubmatrix = { a: 0.6819983600624985, b: 0, c: 0, d: 1, e: 0, f: 0 };
    expect(svgAffineMaxPointError(blinkUsed, apparentSubmatrix)).toBeGreaterThan(11);
  });
});
