import { describe, expect, it } from "vitest";

import {
  contentQuad,
  intersectPolygons,
  mapPolygon,
  offscreenPolygonClip,
  rectangleHomography,
  rectPolygon,
  type Polygon,
} from "./real-world-webgl-geometry.js";

const page = { x: 0, y: 0, width: 100, height: 100, scrollX: 0, scrollY: 0, documentWidth: 4000, documentHeight: 4000 };

describe("authenticated preflight plane geometry", () => {
  it("maps a true projective midpoint rather than bilinear/AABB interpolation", () => {
    const quad = contentQuad([0, 0, 50, 0, 50, 50, 0, 100])!;
    const mapping = rectangleHomography(100, 100, quad)!;
    const point = mapPolygon(mapping, [{ x: 50, y: 50 }])![0];
    expect(point.x).toBeCloseTo(100 / 3, 10);
    expect(point.y).toBeCloseTo(100 / 3, 10);
    expect(point).not.toEqual({ x: 25, y: 37.5 });
    expect(mapPolygon(mapping, rectPolygon({ x: 0, y: 0, width: 100, height: 100 }))).toEqual(quad);
  });
  it("preserves reflected corner identity and fractional source widths", () => {
    const quad = contentQuad([100, 0, 0, 0, 0, 50, 100, 50])!;
    const [point] = mapPolygon(rectangleHomography(80.5, 60, quad)!, [{ x: 40.25, y: 30 }])!;
    expect(point.x).toBeCloseTo(50, 10);
    expect(point.y).toBeCloseTo(25, 10);
  });
  it.each(
    [
      [],
      [0, 0, 1, 0, 1, 1],
      [0, 0, 1, 0, 1, 1, NaN, 1],
      [0, 0, 1, 1, 1, 0, 0, 1],
      [0, 0, 1, 0, 2, 0, 3, 0],
      [0, 0, 1, 0, 0.5, 0.5, 0, 1],
    ].map((quad) => ({ quad })),
  )("refuses malformed, self-crossing, singular or concave quads $quad", ({ quad }) => {
    expect(contentQuad(quad)).toBeNull();
  });
  it.each([0, -1, Infinity, NaN])("refuses unusable source dimensions %s", (width) => {
    expect(rectangleHomography(width, 10, rectPolygon({ x: 0, y: 0, width: 10, height: 10 }))).toBeNull();
  });
  it("refuses a denominator crossing or behind the authenticated plane", () => {
    expect(
      mapPolygon(
        [1, 0, 0, 0, 1, 0, 1, 0, -0.5],
        [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ],
      ),
    ).toBeNull();
    expect(mapPolygon([1, 0, 0, 0, 1, 0, 0, 0, -1], [{ x: 0, y: 0 }])).toBeNull();
  });
  it("clips before crossing a local-root homography domain", () => {
    const source = rectPolygon({ x: -2, y: 0, width: 2.5, height: 1 });
    const domain = rectPolygon({ x: 0, y: 0, width: 1, height: 1 });
    expect(mapPolygon([1, 0, 0, 0, 1, 0, 1, 0, 1], source)).toBeNull();
    const clipped = intersectPolygons(source, domain);
    expect(mapPolygon([1, 0, 0, 0, 1, 0, 1, 0, 1], clipped)).not.toBeNull();
  });
  it("distinguishes polygon clipping from overlapping bounding boxes", () => {
    const diamond: Polygon = [
      { x: 0, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 200 },
      { x: -100, y: 100 },
    ];
    const outside = rectPolygon({ x: 60, y: 145, width: 20, height: 20 });
    expect(intersectPolygons(outside, diamond)).toEqual([]);
    expect(intersectPolygons(outside, [...diamond].reverse())).toEqual([]);
    expect(offscreenPolygonClip(outside, page, [diamond])).toBeNull();
  });
  it("keeps the exact partially clipped plane and either winding", () => {
    const a = rectPolygon({ x: 0, y: 500, width: 40, height: 40 });
    const b = rectPolygon({ x: 20, y: 510, width: 40, height: 20 });
    for (const clip of [b, [...b].reverse()]) {
      const result = intersectPolygons(a, clip);
      expect(result).toHaveLength(4);
      expect(result).toEqual(
        expect.arrayContaining([
          { x: 20, y: 510 },
          { x: 40, y: 510 },
          { x: 40, y: 530 },
          { x: 20, y: 530 },
        ]),
      );
    }
  });
  it("does not confuse a viewport-overlapping AABB with actual viewport paint", () => {
    const polygon = [
      { x: 110, y: 95 },
      { x: 95, y: 110 },
      { x: 110, y: 110 },
    ];
    expect(offscreenPolygonClip(polygon, page)).toEqual({ x: 95, y: 95, width: 15, height: 15, scale: 1 });
    expect(offscreenPolygonClip(rectPolygon({ x: 90, y: 90, width: 40, height: 40 }), page)).toBeNull();
  });
  it("caps large diagonal clips around a proven interior point", () => {
    const polygon = [
      { x: 0, y: 1200 },
      { x: 1200, y: 0 },
      { x: 2400, y: 1200 },
      { x: 1200, y: 2400 },
    ];
    const clip = offscreenPolygonClip(polygon, page)!;
    expect(clip).toEqual({ x: 944, y: 944, width: 512, height: 512, scale: 1 });
    expect(intersectPolygons(polygon, rectPolygon({ x: 0, y: 0, width: 512, height: 512 }))).toEqual([]);
    expect(intersectPolygons(polygon, rectPolygon(clip)).length).toBeGreaterThan(0);
  });
  it("clips to document polygons before rounding and scroll translation", () => {
    expect(
      offscreenPolygonClip(rectPolygon({ x: 20.2, y: 500.3, width: 40, height: 30 }), {
        ...page,
        scrollX: 10,
        scrollY: 200,
      }),
    ).toEqual({ x: 30, y: 700, width: 41, height: 31, scale: 1 });
    expect(
      offscreenPolygonClip(
        [
          { x: -5, y: 3 },
          { x: 3, y: -5 },
          { x: -5, y: -5 },
        ],
        { ...page, documentWidth: 10, documentHeight: 10 },
      ),
    ).toBeNull();
  });
});
