/**
 * DM-1104: crop an animated (or static) SVG to a sub-rectangle by rewriting the
 * outermost `<svg>`'s `viewBox` + `width`/`height`, a true VECTOR crop — the
 * content is unchanged; only the viewport window onto it moves. The outermost
 * `<svg>` clips to its viewport by default (`overflow: hidden` per SVG 1.1
 * §14.3.3), so everything outside the crop rect is clipped while the rest stays
 * crisp and scalable. The scrubber's PNG / MP4 exports crop the RASTER output to
 * the same rect (Playwright `clip`); the SVG export uses this so the downloaded
 * file stays vector.
 *
 * `crop` is in the SVG's user-space (viewBox) units. Callers should clamp it to
 * the frame first via {@link clampCrop}.
 */

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Clamp a crop rect to the `[0, frameW] × [0, frameH]` frame, guaranteeing a
 * positive-area result. Returns null when the requested rect has no overlap with
 * the frame (degenerate / off-canvas) so callers can treat it as "no crop".
 */
export function clampCrop(crop: CropRect, frameW: number, frameH: number): CropRect | null {
  const x0 = Math.max(0, Math.min(crop.x, frameW));
  const y0 = Math.max(0, Math.min(crop.y, frameH));
  const x1 = Math.max(0, Math.min(crop.x + crop.w, frameW));
  const y1 = Math.max(0, Math.min(crop.y + crop.h, frameH));
  const w = x1 - x0;
  const h = y1 - y0;
  if (!(w > 0 && h > 0)) return null;
  return { x: x0, y: y0, w, h };
}

/**
 * Rewrite the outermost `<svg>` element so its viewport is `crop` (in user
 * units). Sets `viewBox="x y w h"` and `width="w" height="h"` and forces
 * `overflow:hidden` (defensive — the outer SVG already clips, but a stray author
 * `overflow:visible` on the root would leak cropped content). Other attributes
 * are preserved. Throws if no `<svg>` open tag is found.
 */
export function cropSvgViewBox(svg: string, crop: CropRect): string {
  const m = /<svg\b[^>]*>/i.exec(svg);
  if (m == null) throw new Error("cropSvgViewBox: no <svg> element found");
  const openTag = m[0];

  // Strip the self-closing slash (none expected on a root container) and the
  // trailing ">"; we rebuild the closing.
  const inner = openTag.replace(/^<svg\b/i, "").replace(/\/?>$/, "");

  // Drop any existing viewBox / width / height / (root) style so our values win,
  // then re-append. We keep all other attributes (xmlns, class, etc.).
  let attrs = inner
    .replace(/\sviewBox\s*=\s*("[^"]*"|'[^']*')/i, "")
    .replace(/\swidth\s*=\s*("[^"]*"|'[^']*')/i, "")
    .replace(/\sheight\s*=\s*("[^"]*"|'[^']*')/i, "");

  // Merge overflow:hidden into an existing root style= if present, else add one.
  const styleRe = /\sstyle\s*=\s*("([^"]*)"|'([^']*)')/i;
  const sm = styleRe.exec(attrs);
  if (sm != null) {
    const body = (sm[2] ?? sm[3] ?? "").replace(/overflow\s*:\s*[^;]+;?/gi, "").trim();
    const merged = `overflow:hidden;${body ? `${body.endsWith(";") ? body : `${body};`}` : ""}`.replace(/;+/g, ";");
    attrs = attrs.replace(styleRe, ` style="${merged}"`);
  } else {
    attrs += ` style="overflow:hidden"`;
  }

  const x = num(crop.x), y = num(crop.y), w = num(crop.w), h = num(crop.h);
  const rebuilt = `<svg${attrs} viewBox="${x} ${y} ${w} ${h}" width="${w}" height="${h}">`;
  return svg.slice(0, m.index) + rebuilt + svg.slice(m.index + openTag.length);
}

/** Trim trailing-zero noise from a number for compact attribute output. */
function num(n: number): string {
  return Number.isFinite(n) ? String(Math.round(n * 1000) / 1000) : "0";
}
