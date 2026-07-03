/**
 * DM-1588: inline a captured `<img src="*.svg">` as a native, resolution-
 * independent `<svg>` in the output instead of a rasterized-on-zoom
 * `<image href="data:image/svg+xml;base64,…">`.
 *
 * Chromium paints an SVG referenced from an `<image>` (or an `<img>`) by
 * rasterizing it at the element's layout size and then scaling THAT raster —
 * so the logo softens / aliases at high zoom (the user-reported `brand-mixed`
 * symptom). A nested native `<svg>` stays truly vector at any scale, drops the
 * ~33% base64 bloat, and is more cross-engine-robust than an SVG-in-`<image>`.
 *
 * The two public helpers here are the shared plumbing for that:
 *   - `prefixSvgIds` namespaces every `id` / hash-reference / `url(#…)` in an
 *     SVG fragment so multiple inlined SVGs (and the outer document) can't
 *     collide on gradient / clipPath / filter / mask ids.
 *   - `inlineImgSvg` rewrites an SVG file's root `<svg>` into a positioned,
 *     sized, id-namespaced nested `<svg>` ready to drop into the output.
 *
 * `prefixSvgIds` is also consumed by the animator's svg-overlay inliner (which
 * additionally strips the outer wrapper) so the namespacing regexes live in
 * exactly one place.
 */

import { r } from "./format.js";

/**
 * Prefix every `id="…"`, `href="#…"`, `xlink:href="#…"`, and `url(#…)` in an
 * SVG fragment with `prefix` so its internal references stay self-consistent
 * while no longer colliding with ids elsewhere in the host document. Handles
 * both single- and double-quoted attribute forms. Class selectors inside a
 * `<style>` block are intentionally NOT rewritten — see the module note.
 */
export function prefixSvgIds(svg: string, prefix: string): string {
  let out = svg;
  out = out.replace(/\bid="([^"]+)"/g, (_m, id: string) => `id="${prefix}${id}"`);
  out = out.replace(/\bid='([^']+)'/g, (_m, id: string) => `id='${prefix}${id}'`);
  out = out.replace(
    /\b(href|xlink:href)="#([^"]+)"/g,
    (_m, attr: string, id: string) => `${attr}="#${prefix}${id}"`,
  );
  out = out.replace(
    /\b(href|xlink:href)='#([^']+)'/g,
    (_m, attr: string, id: string) => `${attr}='#${prefix}${id}'`,
  );
  out = out.replace(/url\(#([^)]+)\)/g, (_m, id: string) => `url(#${prefix}${id})`);
  return out;
}

/** Read a numeric SVG length attribute (`width`/`height`), stripping a `px`
 *  unit suffix. Returns null for `%`, `em`, `auto`, missing, or non-finite. */
function readLengthAttr(attrs: string, name: string): number | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`, "i").exec(attrs);
  if (m == null) return null;
  let v = m[1];
  if ((v.startsWith("\"") && v.endsWith("\"")) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  v = v.trim();
  if (/%$/.test(v)) return null; // percentage widths have no absolute coordinate system
  const n = parseFloat(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Extract the root `<svg>`'s `viewBox` value (inner string), or null. */
function extractViewBox(attrs: string): string | null {
  const m = /\bviewBox\s*=\s*("[^"]*"|'[^']*')/i.exec(attrs);
  if (m == null) return null;
  const vb = m[1].slice(1, -1).trim();
  return vb === "" ? null : vb;
}

/** Remove the given attributes (case-insensitive names) from a `<svg>` tag's
 *  attribute string, so the caller can re-declare them. */
function stripAttrs(attrs: string, names: string[]): string {
  let out = attrs;
  for (const name of names) {
    out = out.replace(
      new RegExp(`\\s${name}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`, "gi"),
      "",
    );
  }
  return out;
}

export interface InlineSvgPlacement {
  /** Content-box top-left + size to place the SVG at (px, already border/pad-adjusted). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** SVG `preserveAspectRatio` derived from CSS object-fit / object-position. */
  par: string;
  /** The `<img>`'s intrinsic size, used to synthesize a viewBox when the SVG
   *  itself declares neither a viewBox nor absolute width/height. */
  intrinsic?: { w: number; h: number } | null;
  /** Unique per-document prefix for namespacing the SVG's internal ids. */
  idPrefix: string;
}

/**
 * Rewrite an SVG file's source into a positioned, sized, id-namespaced nested
 * `<svg>` element ready to embed in the output document. Returns null (caller
 * falls back to the raster `<image>` path) when the source has no `<svg>` root
 * or no usable coordinate system (no viewBox, no absolute width/height, and no
 * intrinsic size) — without a coordinate system a nested `<svg width/height>`
 * couldn't scale its contents to the placement rect.
 *
 * The placement rect + `preserveAspectRatio` go on the nested `<svg>`, which
 * scales its `viewBox` coordinate system into that rect exactly the way an
 * `<img>` scales the source — but as live vector geometry, so it stays crisp at
 * any zoom.
 */
export function inlineImgSvg(svgText: string, p: InlineSvgPlacement): string | null {
  const tag = /<svg\b([^>]*)>/i.exec(svgText);
  if (tag == null) return null;
  let attrs = tag[1];

  // Resolve a coordinate system: the SVG's own viewBox, else one synthesized
  // from its absolute width/height, else from the <img> intrinsic size.
  let viewBox = extractViewBox(attrs);
  if (viewBox == null) {
    let vw = readLengthAttr(attrs, "width");
    let vh = readLengthAttr(attrs, "height");
    if ((vw == null || vh == null) && p.intrinsic != null && p.intrinsic.w > 0 && p.intrinsic.h > 0) {
      vw = p.intrinsic.w;
      vh = p.intrinsic.h;
    }
    if (vw == null || vh == null) return null;
    viewBox = `0 0 ${r(vw)} ${r(vh)}`;
  }

  // Strip the attrs we re-declare (keep xmlns / class / style / role / etc.).
  attrs = stripAttrs(attrs, ["x", "y", "width", "height", "viewBox", "preserveAspectRatio"]);
  // Namespace ids: the root tag's own attrs (a root `id`/`url(#…)` is rare but
  // legal) and the whole body (defs + references).
  const rootAttrs = prefixSvgIds(attrs, p.idPrefix).replace(/\s+$/, "");
  const body = prefixSvgIds(svgText.slice(tag.index + tag[0].length), p.idPrefix);

  const open =
    `<svg${rootAttrs}` +
    ` x="${r(p.x)}" y="${r(p.y)}" width="${r(p.w)}" height="${r(p.h)}"` +
    ` viewBox="${viewBox}" preserveAspectRatio="${p.par}">`;
  return open + body;
}
