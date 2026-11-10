/** Harness-only planar geometry. Quads retain Blink/CDP corner order, including reflections. */
export interface Point {
  x: number;
  y: number;
}
export interface GeometryRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export type Polygon = Point[];
export type Homography = readonly [number, number, number, number, number, number, number, number, number];
export const MAX_CANVAS_CLIP_SIDE = 512;
const EPSILON = 1e-8;
const cross = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);

export function rectPolygon(rect: GeometryRect): Polygon {
  return [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ];
}

function signedArea(points: Polygon): number {
  return (
    points.reduce((sum, p, index) => {
      const q = points[(index + 1) % points.length];
      return sum + p.x * q.y - p.y * q.x;
    }, 0) / 2
  );
}

export function contentQuad(values: readonly number[]): Polygon | null {
  if (values.length !== 8 || !values.every(Number.isFinite)) return null;
  const points = Array.from({ length: 4 }, (_, index) => ({ x: values[index * 2], y: values[index * 2 + 1] }));
  const turns = points.map((p, index) => cross(p, points[(index + 1) % 4], points[(index + 2) % 4]));
  return turns.every(Number.isFinite) && (turns.every((n) => n > EPSILON) || turns.every((n) => n < -EPSILON))
    ? points
    : null;
}

/** Rectangle-to-plane map; normalized W must remain positive over the entire source rectangle. */
export function rectangleHomography(width: number, height: number, quad: Polygon): Homography | null {
  if (!(width > 0 && height > 0) || !Number.isFinite(width + height) || quad.length !== 4) return null;
  if (contentQuad(quad.flatMap((p) => [p.x, p.y])) == null) return null;
  const [p0, p1, p2, p3] = quad;
  const dx1 = p1.x - p2.x,
    dx2 = p3.x - p2.x,
    dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y,
    dy2 = p3.y - p2.y,
    dy3 = p0.y - p1.y + p2.y - p3.y;
  let g = 0,
    h = 0;
  if (Math.abs(dx3) + Math.abs(dy3) > EPSILON) {
    const determinant = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(determinant) < EPSILON) return null;
    g = (dx3 * dy2 - dx2 * dy3) / determinant;
    h = (dx1 * dy3 - dx3 * dy1) / determinant;
  }
  const result: Homography = [
    (p1.x - p0.x + g * p1.x) / width,
    (p3.x - p0.x + h * p3.x) / height,
    p0.x,
    (p1.y - p0.y + g * p1.y) / width,
    (p3.y - p0.y + h * p3.y) / height,
    p0.y,
    g / width,
    h / height,
    1,
  ];
  if (!result.every(Number.isFinite) || [1, 1 + g, 1 + g + h, 1 + h].some((w) => w <= EPSILON)) return null;
  return result;
}

export function mapPolygon(matrix: Homography, points: Polygon): Polygon | null {
  const denominators = points.map((p) => matrix[6] * p.x + matrix[7] * p.y + matrix[8]);
  if (denominators.some((w) => !Number.isFinite(w) || w <= EPSILON)) return null;
  const mapped = points.map((p, index) => ({
    x: (matrix[0] * p.x + matrix[1] * p.y + matrix[2]) / denominators[index],
    y: (matrix[3] * p.x + matrix[4] * p.y + matrix[5]) / denominators[index],
  }));
  return mapped.every((p) => Number.isFinite(p.x + p.y)) ? mapped : null;
}

/** Sutherland–Hodgman in the authenticated common viewport, before any screenshot AABB. */
export function intersectPolygons(subject: Polygon, clip: Polygon): Polygon {
  if (subject.length < 3 || clip.length < 3) return [];
  const orientation = Math.sign(signedArea(clip));
  if (orientation === 0) return [];
  let result = subject;
  for (let index = 0; index < clip.length; index++) {
    const a = clip[index],
      b = clip[(index + 1) % clip.length];
    const input = result;
    result = [];
    for (let vertex = 0; vertex < input.length; vertex++) {
      const current = input[vertex],
        previous = input[(vertex + input.length - 1) % input.length];
      const dc = orientation * cross(a, b, current),
        dp = orientation * cross(a, b, previous);
      const inside = dc >= 0,
        wasInside = dp >= 0;
      if (inside !== wasInside) {
        const t = dp / (dp - dc);
        result.push({ x: previous.x + t * (current.x - previous.x), y: previous.y + t * (current.y - previous.y) });
      }
      if (inside) result.push(current);
    }
    if (result.length < 3) return [];
  }
  return Math.abs(signedArea(result)) > EPSILON ? result : [];
}

export interface ScreenshotPage extends GeometryRect {
  scrollX: number;
  scrollY: number;
  documentWidth: number;
  documentHeight: number;
}

export function offscreenPolygonClip(
  polygon: Polygon,
  page: ScreenshotPage,
  clips: Polygon[] = [],
): (GeometryRect & { scale: 1 }) | null {
  if (polygon.length < 3 || !polygon.every((p) => Number.isFinite(p.x + p.y))) return null;
  let visible = polygon;
  for (const clip of [
    ...clips,
    rectPolygon({ x: -page.scrollX, y: -page.scrollY, width: page.documentWidth, height: page.documentHeight }),
  ]) {
    visible = intersectPolygons(visible, clip);
    if (visible.length < 3) return null;
  }
  if (intersectPolygons(visible, rectPolygon(page)).length > 0) return null;
  const left = Math.max(0, Math.floor(Math.min(...visible.map((p) => p.x)) + page.scrollX));
  const top = Math.max(0, Math.floor(Math.min(...visible.map((p) => p.y)) + page.scrollY));
  const right = Math.min(page.documentWidth, Math.ceil(Math.max(...visible.map((p) => p.x)) + page.scrollX));
  const bottom = Math.min(page.documentHeight, Math.ceil(Math.max(...visible.map((p) => p.y)) + page.scrollY));
  const width = Math.min(MAX_CANVAS_CLIP_SIDE, right - left),
    height = Math.min(MAX_CANVAS_CLIP_SIDE, bottom - top);
  if (width <= 0 || height <= 0) return null;
  // A capped AABB's top-left corner can miss a large diagonal plane entirely. Keep a proven interior point.
  const center = visible.reduce((sum, p) => ({ x: sum.x + p.x / visible.length, y: sum.y + p.y / visible.length }), {
    x: page.scrollX,
    y: page.scrollY,
  });
  const x = Math.max(left, Math.min(right - width, Math.floor(center.x - width / 2)));
  const y = Math.max(top, Math.min(bottom - height, Math.floor(center.y - height / 2)));
  return { x, y, width, height, scale: 1 };
}
