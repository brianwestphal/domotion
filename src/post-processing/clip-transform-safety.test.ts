import { describe, it, expect } from "vitest";
import { findFillBoxInClipOrMask, assertNoFillBoxInClipOrMask } from "./clip-transform-safety.js";

describe("findFillBoxInClipOrMask (DM-1529)", () => {
  it("flags an inline transform-box:fill-box on a clipPath child", () => {
    const svg =
      `<svg><clipPath id="c"><rect style="transform-box: fill-box; transform-origin: left top" width="10" height="10"/></clipPath></svg>`;
    const v = findFillBoxInClipOrMask(svg);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("<clipPath>");
    expect(v[0]).toContain("inline");
  });

  it("flags an inline fill-box on a mask child", () => {
    const svg = `<svg><mask id="m"><rect style="transform-box:fill-box" width="10" height="10"/></mask></svg>`;
    const v = findFillBoxInClipOrMask(svg);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("<mask>");
  });

  it("flags fill-box applied via a class rule inside a clipPath", () => {
    const svg =
      `<svg><style>.piv{transform-box: fill-box; transform-origin: center}</style>` +
      `<clipPath id="c"><rect class="piv" width="10" height="10"/></clipPath></svg>`;
    const v = findFillBoxInClipOrMask(svg);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain(".piv");
  });

  it("does NOT flag fill-box on a normal element outside clip/mask", () => {
    // fill-box on an ordinary rendered <g> is honored by Firefox — safe.
    const svg =
      `<svg><style>.pop{transform-box: fill-box; transform-origin: center}</style>` +
      `<g class="pop"><rect width="10" height="10"/></g></svg>`;
    expect(findFillBoxInClipOrMask(svg)).toHaveLength(0);
  });

  it("does NOT flag a clipPath whose child has no fill-box (userspace origin)", () => {
    const svg =
      `<svg><style>.clipper{transform-origin:64px 0px}</style>` +
      `<clipPath id="c" clipPathUnits="userSpaceOnUse"><rect class="clipper" width="10" height="10"/></clipPath></svg>`;
    expect(findFillBoxInClipOrMask(svg)).toHaveLength(0);
  });

  it("reports one violation per matching class usage across multiple clip/mask defs", () => {
    const svg =
      `<svg><style>.piv{transform-box:fill-box}</style>` +
      `<clipPath id="c1"><rect class="piv"/></clipPath>` +
      `<mask id="m1"><rect class="piv"/></mask></svg>`;
    expect(findFillBoxInClipOrMask(svg)).toHaveLength(2);
  });
});

describe("assertNoFillBoxInClipOrMask (DM-1529)", () => {
  it("throws with the context + violations when a trap is present", () => {
    const svg = `<svg><clipPath id="c"><rect style="transform-box:fill-box"/></clipPath></svg>`;
    expect(() => assertNoFillBoxInClipOrMask(svg, "layer.svg")).toThrow(/layer\.svg/);
    expect(() => assertNoFillBoxInClipOrMask(svg)).toThrow(/Firefox/);
  });

  it("is a no-op on clean svg", () => {
    const svg = `<svg><clipPath id="c"><rect width="10" height="10"/></clipPath></svg>`;
    expect(() => assertNoFillBoxInClipOrMask(svg)).not.toThrow();
  });
});
