import { describe, expect, it } from "vitest";
import type { CapturedImagePaintBasis } from "../capture/types.js";
import {
  authenticImagePaintBasis,
  imagePaintIntoRect,
  intersectPaintRects,
  paintRectContains,
  snapImagePaintRect,
} from "./image-paint-snap.js";

const basis = (
  origin: { x: number; y: number },
  shift = { x: 0, y: 0 },
  size = { width: 358, height: 525.234375 },
): CapturedImagePaintBasis => ({ source: "blink-image-paint-basis-v1", origin, shift, ...size });

describe("snapImagePaintRect", () => {
  it("snaps in the local paint space rather than the captured coordinates", () => {
    // A fractional captured origin whose local paint offset is whole: the
    // rect stays put (no global rounding of the captured coordinates).
    const el = { x: 16, y: 104.484375 };
    expect(
      snapImagePaintRect(el, basis({ x: 0, y: 0 }), { x: 16, y: 104.484375, width: 358, height: 525.234375 }),
    ).toEqual({ x: 16, y: 104.484375, width: 358, height: 525 });
  });

  it("reproduces the ordinary ToPixelSnappedRect when the local and captured spaces agree", () => {
    const el = { x: 16, y: 104.484375 };
    expect(
      snapImagePaintRect(el, basis({ x: 0, y: 0.484375 }), { x: 16, y: 104.484375, width: 358, height: 525.234375 }),
    ).toEqual({ x: 16, y: 104, width: 358, height: 526 });
  });

  it("applies a paint-isolation shift to the whole local space", () => {
    // Isolation rounded the ancestor's offset by -0.484375 and the image sits
    // at whole local offsets beneath it: Blink paints 16,104,358,525.
    const el = { x: 16, y: 104.484375 };
    expect(
      snapImagePaintRect(el, basis({ x: 0, y: 0 }, { x: 0, y: -0.484375 }), {
        x: 16,
        y: 104.484375,
        width: 358,
        height: 525.234375,
      }),
    ).toEqual({ x: 16, y: 104, width: 358, height: 525 });
  });

  it("snaps an inner rectangle relative to the border-box basis", () => {
    const el = { x: 10.25, y: 0 };
    // Local border-box offset 0.25; an object rect 3.5px further is at local
    // 3.75, which rounds to 4: captured 10.25 + 4 - 0.25 = 14.
    expect(snapImagePaintRect(el, basis({ x: 0.25, y: 0 }), { x: 13.75, y: 0, width: 10, height: 10 })).toEqual({
      x: 14,
      y: 0,
      width: 10,
      height: 10,
    });
  });

  it("keeps a nonzero size of more than four LayoutUnits at one pixel", () => {
    expect(
      snapImagePaintRect({ x: 0, y: 0 }, basis({ x: 0, y: 0 }), { x: 0.2, y: 0, width: 0.25, height: 0.01 }),
    ).toEqual({ x: 0, y: 0, width: 1, height: 0 });
  });
});

describe("imagePaintIntoRect", () => {
  const el = { x: 0, y: 0 };
  const b = basis({ x: 0, y: 0 });
  it("draws the whole snapped destination when the content box contains it", () => {
    expect(
      imagePaintIntoRect(el, b, { x: 1.4, y: 1.6, width: 10, height: 10 }, { x: 0, y: 0, width: 20, height: 20 }),
    ).toEqual({ dest: { x: 1, y: 2, width: 10, height: 10 }, crop: null });
  });

  it("crops to the snapped content rect intersected with the snapped destination", () => {
    expect(
      imagePaintIntoRect(el, b, { x: -3.3, y: 1.7, width: 24, height: 18 }, { x: 0.4, y: 0.4, width: 16, height: 16 }),
    ).toEqual({
      dest: { x: -3, y: 2, width: 24, height: 18 },
      crop: { x: 0, y: 2, width: 16, height: 14 },
    });
  });
});

describe("rect helpers", () => {
  it("contains and intersects", () => {
    expect(paintRectContains({ x: 0, y: 0, width: 4, height: 4 }, { x: 1, y: 1, width: 3, height: 3 })).toBe(true);
    expect(paintRectContains({ x: 0, y: 0, width: 4, height: 4 }, { x: 1, y: 1, width: 4, height: 3 })).toBe(false);
    expect(intersectPaintRects({ x: 0, y: 0, width: 2, height: 2 }, { x: 3, y: 3, width: 2, height: 2 })).toEqual({
      x: 3,
      y: 3,
      width: 0,
      height: 0,
    });
  });

  it("ignores a basis recorded for another box size", () => {
    const record = basis({ x: 0, y: 0 }, { x: 0, y: 0 }, { width: 20, height: 20 });
    expect(authenticImagePaintBasis({ x: 0, y: 0, width: 20, height: 20, imagePaintBasis: record })).toBe(record);
    expect(authenticImagePaintBasis({ x: 0, y: 0, width: 21, height: 20, imagePaintBasis: record })).toBeUndefined();
    expect(authenticImagePaintBasis({ x: 0, y: 0, width: 20, height: 20 })).toBeUndefined();
  });
});
