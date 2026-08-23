import { describe, expect, it } from "vitest";
import {
  isNonAffineProjectiveQuad,
  projectiveQuadResidual,
  selectProjectiveRasterOwnerIndexes,
  type ProjectiveOwnershipNode,
} from "./projective-owner.js";

const node = (
  parent: number | null,
  influenced: boolean,
  nonAffine: boolean,
  inlineSvgRoot: number | null = null,
  usedPreserve3d: boolean | null = false,
): ProjectiveOwnershipNode => ({ parent, influenced, usedPreserve3d, nonAffine, inlineSvgRoot });

describe("projective paint quad activation", () => {
  it("distinguishes an affine fourth corner from a projective one", () => {
    const affine = [10, 12, 110, 22, 100, 92, 0, 82] as const;
    const projective = [10, 12, 110, 22, 91, 93, 0, 82] as const;

    expect(projectiveQuadResidual(affine)).toBeCloseTo(0, 12);
    expect(isNonAffineProjectiveQuad(affine)).toBe(false);
    expect(projectiveQuadResidual(projective)).toBeGreaterThan(8);
    expect(isNonAffineProjectiveQuad(projective)).toBe(true);
  });

  it("keeps affine matrix3d and inert SVG perspective vector-owned", () => {
    const nodes = [
      node(null, true, false),
      node(0, true, false, 0),
      node(1, true, false, 0),
    ];

    expect(selectProjectiveRasterOwnerIndexes(nodes)).toEqual([]);
  });
});

describe("projective raster owner selection", () => {
  it("selects the outer edge of one HTML 3D context", () => {
    const nodes = [
      node(null, false, false),
      node(0, true, false, null, true),
      node(1, true, true),
      node(2, true, true),
    ];

    expect(selectProjectiveRasterOwnerIndexes(nodes)).toEqual([1]);
  });

  it("promotes a foreignObject descendant owner to the atomic inline SVG", () => {
    const nodes = [
      node(null, false, false), // outer inline SVG clone
      node(0, false, false, 0), // foreignObject
      node(1, true, false, 0, true),  // HTML preserve-3d host
      node(2, true, true, 0),   // projective HTML child
    ];

    expect(selectProjectiveRasterOwnerIndexes(nodes)).toEqual([0]);
  });

  it("retains an already-owning HTML ancestor above an inline SVG", () => {
    const nodes = [
      node(null, true, false, null, true), // HTML preserve-3d context
      node(0, true, true, 1),   // atomic inline SVG root
      node(1, true, true, 1),   // projective foreignObject descendant
    ];

    expect(selectProjectiveRasterOwnerIndexes(nodes)).toEqual([0]);
  });

  it("coalesces nested projective planes and distinct clone descendants", () => {
    const nodes = [
      node(null, true, true, null, true),
      node(0, true, true),
      node(0, true, true),
    ];

    expect(selectProjectiveRasterOwnerIndexes(nodes)).toEqual([0]);
  });

  it("keeps independent projective contexts as independent owners", () => {
    const nodes = [
      node(null, false, false),
      node(0, true, true),
      node(0, true, true),
    ];

    expect(selectProjectiveRasterOwnerIndexes(nodes)).toEqual([1, 2]);
  });

  it("does not promote a plane through perspective-only or flat ancestors", () => {
    const nodes = [
      node(null, true, false), // perspective host, but no used preserve-3d
      node(0, true, true),
      node(0, true, false),   // flat intermediary
      node(2, true, true),
    ];

    expect(selectProjectiveRasterOwnerIndexes(nodes)).toEqual([1, 3]);
  });

  it("starts a fresh context below a grouping-property break", () => {
    const nodes = [
      node(null, true, false, null, true),
      node(0, true, false), // used flat because opacity/filter/etc groups
      node(1, true, false, null, true),
      node(2, true, true),
    ];

    expect(selectProjectiveRasterOwnerIndexes(nodes)).toEqual([2]);
  });

  it("falls back to the conservative influenced surface for unknown used style", () => {
    const nodes = [
      node(null, true, false, null, null),
      node(0, true, true),
    ];

    expect(selectProjectiveRasterOwnerIndexes(nodes)).toEqual([0]);
  });
});
