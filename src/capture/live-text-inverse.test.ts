import { describe, expect, it } from "vitest";
import { invertLiveTextQuad, invertLiveTextRect, liveTextInverse } from "./live-text-inverse.js";

const owner = { x: 20.375, y: 13.9375, width: 294, height: 40 };
const sampled = { a: 1.5, b: 0, c: 0, d: 1.25, e: 3.125, f: -4.25 };
const origin = { x: 6.5, y: 8.25 };
const inverse = liveTextInverse(owner, sampled, origin)!;

describe("live direct text layout coordinates (DM-2CF8YE)", () => {
  it("reconstructs the local box about the fractional transform origin", () => {
    expect(invertLiveTextRect(owner, inverse)).toEqual({ x: 20.5, y: 20.25, width: 196, height: 32 });
  });

  it("normalizes a text-node protocol quad in capture coordinates", () => {
    const viewport = { x: 7, y: 3 };
    expect(
      invertLiveTextQuad([13.375, 10.9375, 28.375, 10.9375, 28.375, 25.9375, 13.375, 25.9375], inverse, viewport),
    ).toEqual([13.5, 17.25, 23.5, 17.25, 23.5, 29.25, 13.5, 29.25]);
  });

  it("preserves the empty Range sentinel and zero-width positioned fragments", () => {
    const empty = { x: 0, y: 0, width: 0, height: 0 };
    expect(invertLiveTextRect(empty, inverse)).toEqual(empty);
    expect(invertLiveTextRect({ ...owner, width: 0 }, inverse)).toEqual({
      x: 20.5,
      y: 20.25,
      width: 0,
      height: 32,
    });
  });

  it("rejects unproved geometry and out-of-grid points", () => {
    expect(liveTextInverse(owner, { ...sampled, b: 0.1 }, origin)).toBeUndefined();
    expect(liveTextInverse(owner, { ...sampled, d: 1 }, origin)).toBeUndefined();
    expect(liveTextInverse(owner, { ...sampled, a: -1 }, origin)).toBeUndefined();
    expect(liveTextInverse({ ...owner, x: owner.x + 0.004 }, sampled, origin)).toBeUndefined();
    expect(invertLiveTextRect({ ...owner, x: owner.x + 0.004 }, inverse)).toBeUndefined();
  });
});
