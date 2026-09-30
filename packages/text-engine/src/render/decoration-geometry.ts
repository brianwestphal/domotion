/** Mechanical extraction from font-resolution.ts; preserve resolver behavior. */

/**
 * Text-decoration geometry, transcribed from Blink (Chromium rev 7d859f27).
 * All values are UNSNAPPED CSS px — the paint-time y-snap
 * (`decoration_line_painter.cc` `SnapYAxis` / `RoundDownThickness`) is
 * applied where the line is emitted, because the solid/double snap differs
 * from the dashed/dotted midpoint snap and wavy is not snapped at all.
 */
export interface DecorationMetrics {
  /** Resolved decoration thickness — `ComputeDecorationThickness`
   *  (`core/paint/text_decoration_info.cc:65-92`: auto → fontSize/10,
   *  `from-font` → the face's underline thickness metric, length/percent →
   *  `roundf(px)`), then `max(1, t)` (`:449-451`). */
  thickness: number;
  /** Underline rect TOP, px below the text fragment's top edge
   *  (`core/layout/text_decoration_offset.cc:16-48,52-89,91-120`). */
  underlineTop: number;
  /** Overline rect TOP, px below the fragment top —
   *  `floor(LU(FloatAscent − Ascent)) − floor(t)`
   *  (`text_decoration_offset.cc:52-89`, `FontVerticalPositionType::TextTop`). */
  overlineTop: number;
  /** Line-through rect TOP, px below the fragment top —
   *  `2·FloatAscent/3 − t/2`, unrounded
   *  (`core/paint/text_decoration_info.cc:385-386`). */
  lineThroughTop: number;
}

export function mergeGaps(gaps: Array<[number, number]>): Array<[number, number]> {
  gaps.sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const g of gaps) {
    const top = out[out.length - 1];
    if (top != null && g[0] <= top[1]) top[1] = Math.max(top[1], g[1]);
    else out.push([g[0], g[1]]);
  }
  return out;
}

interface IPt {
  x: number;
  y: number;
}

export function glyphPathIntercepts(
  path: { commands: Array<{ command: string; args: number[] }> },
  glyphX: number,
  scale: number,
  yTop: number,
  yBot: number,
): { minX: number; maxX: number } | null {
  // fontkit y is up-positive in glyph space; screen y is down-positive. We
  // express screen y relative to baseline so screenY = -fy * scale and yTop /
  // yBot come in as baseline-relative (positive = below baseline).
  let prev: IPt | null = null;
  let subStart: IPt | null = null;
  let minX = Infinity;
  let maxX = -Infinity;
  function pt(fx: number, fy: number): IPt {
    return { x: glyphX + fx * scale, y: -fy * scale };
  }
  function update(x: number) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
  }
  function segCheck(a: IPt, b: IPt) {
    const ymin = Math.min(a.y, b.y);
    const ymax = Math.max(a.y, b.y);
    if (ymax < yTop || ymin > yBot) return;
    if (a.y >= yTop && a.y <= yBot) update(a.x);
    if (b.y >= yTop && b.y <= yBot) update(b.x);
    const dy = b.y - a.y;
    if (Math.abs(dy) > 1e-9) {
      const dx = b.x - a.x;
      const t1 = (yTop - a.y) / dy;
      if (t1 > 0 && t1 < 1) update(a.x + t1 * dx);
      const t2 = (yBot - a.y) / dy;
      if (t2 > 0 && t2 < 1) update(a.x + t2 * dx);
    }
  }
  function quadAt(p0: IPt, p1: IPt, p2: IPt, t: number): IPt {
    const u = 1 - t;
    return { x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x, y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y };
  }
  function cubAt(p0: IPt, p1: IPt, p2: IPt, p3: IPt, t: number): IPt {
    const u = 1 - t;
    return {
      x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
      y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
    };
  }
  function flattenQuad(p0: IPt, p1: IPt, p2: IPt) {
    const STEPS = 8;
    let last = p0;
    for (let i = 1; i <= STEPS; i++) {
      const cur = quadAt(p0, p1, p2, i / STEPS);
      segCheck(last, cur);
      last = cur;
    }
  }
  function flattenCubic(p0: IPt, p1: IPt, p2: IPt, p3: IPt) {
    const STEPS = 12;
    let last = p0;
    for (let i = 1; i <= STEPS; i++) {
      const cur = cubAt(p0, p1, p2, p3, i / STEPS);
      segCheck(last, cur);
      last = cur;
    }
  }
  for (const cmd of path.commands) {
    const a = cmd.args;
    switch (cmd.command) {
      case "moveTo": {
        const p = pt(a[0], a[1]);
        prev = p;
        subStart = p;
        break;
      }
      case "lineTo": {
        const p = pt(a[0], a[1]);
        if (prev) segCheck(prev, p);
        prev = p;
        break;
      }
      case "quadraticCurveTo": {
        const c1 = pt(a[0], a[1]);
        const p = pt(a[2], a[3]);
        if (prev) flattenQuad(prev, c1, p);
        prev = p;
        break;
      }
      case "bezierCurveTo": {
        const c1 = pt(a[0], a[1]);
        const c2 = pt(a[2], a[3]);
        const p = pt(a[4], a[5]);
        if (prev) flattenCubic(prev, c1, c2, p);
        prev = p;
        break;
      }
      case "closePath": {
        if (prev != null && subStart != null) segCheck(prev, subStart);
        prev = subStart;
        break;
      }
    }
  }
  if (minX === Infinity) return null;
  return { minX, maxX };
}
