/**
 * Small read-only helpers for inspecting an already-rendered SVG document's
 * metadata — its intrinsic size and (for an animated SVG) its play length.
 *
 * DM-1339: these were copy-pasted across `composite.ts` (`svgIntrinsicSize`),
 * `cli/composite.ts` (`svgSize` + `detectPeriodMs`), and
 * `templates/builtin/device-mockup.ts` (`svgSize` + `sceneDurationMs`). Extracted
 * here so a future regex fix lands in one place; callers apply their own
 * not-found fallback.
 */

/**
 * Best-effort intrinsic size of an SVG document: the root `width`/`height` attrs
 * (unitless or `px`), else the `viewBox` width/height. `null` when neither is
 * parseable (e.g. a `width="100%"` root with no viewBox).
 */
export function parseSvgIntrinsicSize(svg: string): { w: number; h: number } | null {
  const open = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? "";
  const w = /\bwidth="([\d.]+)(px)?"/i.exec(open);
  const h = /\bheight="([\d.]+)(px)?"/i.exec(open);
  if (w != null && h != null) return { w: parseFloat(w[1]), h: parseFloat(h[1]) };
  const vb = /\bviewBox="[\d.\s-]*?([\d.]+)\s+([\d.]+)"/i.exec(open);
  if (vb != null) return { w: parseFloat(vb[1]), h: parseFloat(vb[2]) };
  return null;
}

/**
 * An animated SVG's own play length (ms): from its `--scene-dur` custom property
 * when present (full-mode casts / `animate` output), else the longest `animation:`
 * shorthand duration (incremental-mode casts carry no `--scene-dur` but every
 * line/cursor track runs at the scene period). `undefined` when neither is found
 * (a static SVG). The first `<time>` in an `animation:` shorthand is its duration.
 */
export function detectAnimationPeriodMs(svg: string): number | undefined {
  const scene = /--scene-dur:\s*([\d.]+)s/i.exec(svg);
  if (scene != null) return Math.round(parseFloat(scene[1]) * 1000);
  let maxSec = 0;
  for (const m of svg.matchAll(/animation:\s*[^;}]*?\b([\d.]+)s\b/gi)) {
    const s = parseFloat(m[1]);
    if (s > maxSec) maxSec = s;
  }
  return maxSec > 0 ? Math.round(maxSec * 1000) : undefined;
}
