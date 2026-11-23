import { describe, expect, it } from "vitest";
import { attributePaintChanges } from "./external-css-svg.js";

function frame(width: number, height: number, paint: Array<[number, number, number]> = [], scale = 1) {
  const data = Buffer.alloc(width * height * 3, 255);
  for (const [x, y, value] of paint) data.fill(value, (y * width + x) * 3, (y * width + x) * 3 + 3);
  return { data, width, height, scale, x: 0, y: 0 };
}
const stable = (width: number, height: number, unstable: Array<[number, number]> = []) => {
  const mask = new Uint8Array(width * height);
  for (const [x, y] of unstable) mask[y * width + x] = 1;
  return mask;
};
const target = (index: number, x: number, y: number, size = 10, animated = false) => ({
  index,
  rect: { x, y, width: size, height: size },
  animated,
});

describe("external CSS SVG paint verification attribution", () => {
  it("returns nothing when the swap is paint-neutral", () => {
    const before = { frame: frame(100, 100), unstable: stable(100, 100) };
    expect(attributePaintChanges(before, frame(100, 100), [target(0, 0, 0)], 0)).toEqual([]);
  });
  it("attributes a stable change to the target that covers it only", () => {
    const before = { frame: frame(100, 100), unstable: stable(100, 100) };
    const after = frame(100, 100, [[5, 5, 0]]);
    expect(attributePaintChanges(before, after, [target(3, 0, 0), target(7, 60, 60)], 0)).toEqual([3]);
  });
  it("ignores pixels that were already unstable before the swap", () => {
    const before = { frame: frame(100, 100), unstable: stable(100, 100, [[5, 5]]) };
    expect(attributePaintChanges(before, frame(100, 100, [[5, 5, 0]]), [target(0, 0, 0)], 0)).toEqual([]);
  });
  it("implicates every verifiable target for a change no target covers", () => {
    const before = { frame: frame(100, 100), unstable: stable(100, 100) };
    const after = frame(100, 100, [[50, 50, 0]]);
    expect(
      attributePaintChanges(before, after, [target(0, 0, 0), target(1, 80, 80), target(2, 20, 20, 5, true)], 0),
    ).toEqual([0, 1]);
  });
  it("keeps animated or paintless targets out of attribution", () => {
    const before = { frame: frame(100, 100), unstable: stable(100, 100) };
    const after = frame(100, 100, [[5, 5, 0]]);
    expect(
      attributePaintChanges(before, after, [target(0, 0, 0, 10, true), { index: 1, rect: null, animated: false }], 0),
    ).toEqual([]);
  });
  it("maps CSS-px rects to device pixels and grows them by the margin", () => {
    const before = { frame: frame(200, 200, [], 2), unstable: stable(200, 200) };
    const after = frame(200, 200, [[45, 45, 0]], 2);
    // CSS rect 10..20 -> device 20..40; a 4px margin reaches device 48.
    expect(attributePaintChanges(before, after, [target(0, 10, 10)], 0)).toEqual([0]); // unattributed → all
    expect(attributePaintChanges(before, after, [target(0, 10, 10), target(1, 80, 80)], 4)).toEqual([0]);
  });
  it("attributes full-page pixels using both document scroll axes", () => {
    const origin = { x: 12, y: 35 };
    const before = { frame: { ...frame(160, 180, [], 2), ...origin }, unstable: stable(160, 180) };
    const after = { ...frame(160, 180, [[30, 100, 0]], 2), ...origin };
    // Device (30,100) is client (3,15); an unshifted mapping would choose target 2.
    expect(attributePaintChanges(before, after, [target(1, 0, 12), target(2, 10, 45)], 0)).toEqual([1]);
  });
  it("refuses a viewport size change between frames", () => {
    const before = { frame: frame(10, 10), unstable: stable(10, 10) };
    expect(() => attributePaintChanges(before, frame(11, 10), [target(0, 0, 0)])).toThrow("viewport changed");
  });
});
