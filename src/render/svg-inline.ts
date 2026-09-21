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
import { computeViewportMatrix, parsePreserveAspectRatio, type ViewBox } from "./svg-viewport-matrix.js";

/**
 * Prefix every `id="…"`, `href="#…"`, `xlink:href="#…"`, and `url(#…)` in an
 * SVG fragment with `prefix` so its internal references stay self-consistent
 * while no longer colliding with ids elsewhere in the host document. Handles
 * both single- and double-quoted attribute forms. Class selectors inside a
 * `<style>` block are intentionally NOT rewritten — see the module note.
 */
export function prefixSvgIds(svg: string, prefix: string): string {
  const ids = new Set<string>();
  for (const match of svg.matchAll(/\bid\s*=\s*(?:"([^"]+)"|'([^']+)')/gi)) ids.add(match[1] ?? match[2]);
  const mapped = (id: string) => (ids.has(id) ? `${prefix}${id}` : id);
  let out = svg;
  out = out.replace(/\bid="([^"]+)"/g, (_m, id: string) => `id="${prefix}${id}"`);
  out = out.replace(/\bid='([^']+)'/g, (_m, id: string) => `id='${prefix}${id}'`);
  out = out.replace(/\b(href|xlink:href)="#([^"]+)"/g, (_m, attr: string, id: string) => `${attr}="#${mapped(id)}"`);
  out = out.replace(/\b(href|xlink:href)='#([^']+)'/g, (_m, attr: string, id: string) => `${attr}='#${mapped(id)}'`);
  out = out.replace(
    /url\(\s*(['"]?)#([^)'"\s]+)\1\s*\)/gi,
    (_m, quote: string, id: string) => `url(${quote}#${mapped(id)}${quote})`,
  );
  // DOM `outerHTML` encodes the quotes inside a serialized style attribute,
  // e.g. `style="clip-path: url(&quot;#clip&quot;)"`.  The presentation
  // attribute above is namespaced too, but the style declaration wins in the
  // cascade; leaving its reference stale silently disables the clip. Preserve
  // the source entity while rewriting its fragment id. This is particularly
  // visible for objectBoundingBox URL clips on cloned SVG graphics (DM-2362).
  out = out.replace(
    /url\(\s*(&quot;|&#34;|&#x22;|&apos;|&#39;|&#x27;)#([^&)\s;]+)\1\s*\)/gi,
    (_m, quote: string, id: string) => `url(${quote}#${mapped(id)}${quote})`,
  );
  const idRefAttrs =
    "aria-activedescendant|aria-controls|aria-describedby|aria-details|aria-errormessage|aria-flowto|aria-labelledby|aria-owns|for";
  out = out.replace(
    new RegExp(`\\b(${idRefAttrs})=("|')([^"']*)\\2`, "gi"),
    (_m, attr: string, quote: string, value: string) =>
      `${attr}=${quote}${value.split(/\s+/).map(mapped).join(" ")}${quote}`,
  );
  out = out.replace(
    /\b(begin|end)=("|')([^"']*)\2/gi,
    (_m, attr: string, quote: string, value: string) =>
      `${attr}=${quote}${value
        .split(";")
        .map((part) =>
          part.replace(
            /^(\s*)([\w:.-]+)(\.)/,
            (_r, space: string, id: string, dot: string) => `${space}${mapped(id)}${dot}`,
          ),
        )
        .join(";")}${quote}`,
  );
  out = out.replace(
    /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi,
    (_m, open: string, css: string, close: string) =>
      open +
      css.replace(
        /([^{}]*)(\{[^{}]*\})/g,
        (_rule, selectors: string, body: string) =>
          selectors.replace(/#(-?[_a-zA-Z][-_a-zA-Z0-9:.]*)/g, (_s, id: string) => `#${mapped(id)}`) + body,
      ) +
      close,
  );
  return out;
}

/**
 * Namespace CSS class names in an SVG fragment with `prefix`, so two inlined
 * SVGs that both define e.g. `.cls-1` in a `<style>` block (common in
 * Illustrator / Figma exports) can't cross-contaminate — an inlined SVG
 * `<style>` applies document-wide (DM-1593, the class-selector counterpart of
 * {@link prefixSvgIds}'s id namespacing). Rewrites:
 *   (a) class selectors in the SELECTOR portion of each rule inside `<style>`
 *       blocks — only the text before each `{`, so a `.` inside a declaration
 *       VALUE (e.g. `stroke-width: 1.5`, `content: ".x"`) is never misread as a
 *       class selector; and
 *   (b) `class="…"` / `class='…'` attribute tokens.
 *
 * Callers gate on `<style>` presence (see {@link inlineImgSvg}) so an SVG with
 * no stylesheet — where class names have no rendering effect — stays
 * byte-identical. Nested at-rules (`@media { … }`) inside an SVG `<style>` are
 * not handled (essentially never present in an SVG asset); the flat
 * `selector { … }` rule shape that design tools emit is.
 */
export function prefixSvgClasses(svg: string, prefix: string): string {
  let out = svg;
  // (a) class selectors inside <style> … </style>, selector-portion only.
  out = out.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_m, open: string, css: string, close: string) => {
    const rewritten = css.replace(
      /([^{}]*)(\{[^{}]*\})/g,
      (_r, sel: string, block: string) =>
        sel.replace(/\.(-?[_a-zA-Z][-_a-zA-Z0-9]*)/g, (_c, name: string) => `.${prefix}${name}`) + block,
    );
    return open + rewritten + close;
  });
  // (b) class attribute tokens (single- or double-quoted).
  out = out.replace(/\bclass=("|')([^"']*)\1/gi, (_m, q: string, val: string) => {
    const toks = val
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => `${prefix}${t}`)
      .join(" ");
    return `class=${q}${toks}${q}`;
  });
  return out;
}

/** Read a numeric SVG length attribute (`width`/`height`), stripping a `px`
 *  unit suffix. Returns null for `%`, `em`, `auto`, missing, or non-finite. */
function readLengthAttr(attrs: string, name: string): number | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`, "i").exec(attrs);
  if (m == null) return null;
  let v = m[1];
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
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
    out = out.replace(new RegExp(`\\s${name}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`, "gi"), "");
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
  let rootAttrs = prefixSvgIds(attrs, p.idPrefix).replace(/\s+$/, "");
  let body = prefixSvgIds(svgText.slice(tag.index + tag[0].length), p.idPrefix);
  // DM-1593: also namespace CSS class names — but ONLY when the SVG carries a
  // `<style>` block (the only way a class can affect rendering, so the common
  // presentation-attribute export stays byte-identical). Gated on the whole
  // source: `<style>` + `class="…"` live in the body; a `class` on the root svg
  // is rare but handled too.
  if (/<style[\s>]/i.test(svgText)) {
    rootAttrs = prefixSvgClasses(rootAttrs, p.idPrefix);
    body = prefixSvgClasses(body, p.idPrefix);
  }

  const open =
    `<svg${rootAttrs}` +
    ` x="${r(p.x)}" y="${r(p.y)}" width="${r(p.w)}" height="${r(p.h)}"` +
    ` viewBox="${viewBox}" preserveAspectRatio="${p.par}">`;
  return open + body;
}

// ── DM-K0S6ZS: opt-in nested-SVG FLATTENING ────────────────────────────────
//
// Some consuming tools (e.g. Sketch) do not import a nested `<svg>` element
// cleanly. `flattenImgSvg` replaces the nested `<svg>` wrapper with a
// `<g transform="matrix(...)">` (from the viewport→viewBox matrix, DM-DQXZ6K),
// plus a rect clip when the source's overflow is hidden. It is opt-in and
// defaults OFF — a nested `<svg>` is the spec-correct, robust default; flattening
// is a compatibility mode. It also GATES: any source that isn't safely
// flattenable (viewport-relative `%` in user space, an inner `<style>` with
// non-id/class selectors, `<symbol>` / a further nested `<svg>` / a `<use>`, or
// `vector-effect="non-scaling-stroke"`) returns null so the caller keeps the
// nested `<svg>`.

let flattenNestedSvgEnabled = false;
/** Enable/disable opt-in nested-SVG flattening for the process (DM-K0S6ZS). */
export function setFlattenNestedSvg(enabled: boolean): void {
  flattenNestedSvgEnabled = enabled;
}
export function getFlattenNestedSvg(): boolean {
  return flattenNestedSvgEnabled;
}

/** Resolve the source SVG's numeric viewBox (own viewBox, else synthesized from
 *  absolute width/height, else the `<img>` intrinsic size), or null. */
function resolveViewBoxRect(attrs: string, intrinsic?: { w: number; h: number } | null): ViewBox | null {
  const vbStr = extractViewBox(attrs);
  if (vbStr != null) {
    const nums = vbStr.split(/[\s,]+/).map(Number);
    if (nums.length === 4 && nums.every((n) => Number.isFinite(n)) && nums[2] > 0 && nums[3] > 0) {
      return { minX: nums[0], minY: nums[1], width: nums[2], height: nums[3] };
    }
    return null;
  }
  let vw = readLengthAttr(attrs, "width");
  let vh = readLengthAttr(attrs, "height");
  if ((vw == null || vh == null) && intrinsic != null && intrinsic.w > 0 && intrinsic.h > 0) {
    vw = intrinsic.w;
    vh = intrinsic.h;
  }
  if (vw == null || vh == null) return null;
  return { minX: 0, minY: 0, width: vw, height: vh };
}

/** Does the source use a `%` on a viewport-relative geometry attribute? Gradient
 *  / pattern / clipPath / mask / filter def blocks (whose `%` is objectBoundingBox-
 *  relative by default, unaffected by the group transform) are removed first;
 *  a `userSpaceOnUse` block with any `%` is treated as unsafe. */
function hasViewportRelativePercent(body: string): boolean {
  const DEF_BLOCK = /<(linearGradient|radialGradient|pattern|clipPath|mask|filter)\b[\s\S]*?<\/\1>/gi;
  const defs: string[] = [];
  const painted = body.replace(DEF_BLOCK, (m) => {
    defs.push(m);
    return " ";
  });
  // Painted (non-def) geometry with any `%` resolves against the viewport.
  if (/=\s*"(?:[^"]*\s)?[-\d.]+%/.test(painted) || /=\s*'(?:[^']*\s)?[-\d.]+%/.test(painted)) return true;
  // A def in user space with any `%` is viewport-relative too.
  for (const d of defs) {
    if (/userSpaceOnUse/i.test(d) && /[-\d.]+%/.test(d)) return true;
  }
  return false;
}

/** A `<style>` selector that isn't purely `.class` / `#id` (an element,
 *  universal, attribute, or pseudo selector) leaks into the outer document once
 *  the SVG is merged, so such a source is not safely flattenable. */
function hasUnscopableStyleSelector(body: string): boolean {
  const styleBlocks = body.match(/<style\b[^>]*>([\s\S]*?)<\/style>/gi);
  if (styleBlocks == null) return false;
  for (const block of styleBlocks) {
    const css = block.replace(/<style\b[^>]*>/i, "").replace(/<\/style>/i, "");
    for (const rule of css.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
      for (const selector of rule[1].split(",")) {
        // Strip class/id tokens and combinators/whitespace; anything left over
        // (a bare element name, `*`, `[attr]`, `:pseudo`) is unscopable.
        const remainder = selector
          .replace(/[.#][-_a-zA-Z0-9]+/g, "")
          .replace(/[\s>+~]+/g, "")
          .trim();
        if (remainder !== "") return true;
      }
    }
  }
  return false;
}

/** Whether the source SVG can be flattened to a `<g transform>` without changing
 *  its rendered result. Conservative: a false negative only costs a fallback to
 *  the (correct) nested `<svg>`; a false positive would mis-render. */
export function isSvgSafeToFlatten(body: string): boolean {
  // Nested viewports / references / embedded HTML — each would need its own
  // viewport expansion (tracked separately, DM-6NT73F).
  if (/<(?:svg|symbol|use|foreignObject|image)\b/i.test(body)) return false;
  // Non-scaling stroke is defined relative to the viewport in effect.
  if (/vector-effect\s*=\s*["']?\s*non-scaling-stroke/i.test(body)) return false;
  if (hasViewportRelativePercent(body)) return false;
  if (hasUnscopableStyleSelector(body)) return false;
  return true;
}

/**
 * DM-K0S6ZS: rewrite an SVG file's source into a positioned, id-namespaced
 * `<g transform="matrix(...)">` (the flattened counterpart of {@link inlineImgSvg})
 * instead of a nested `<svg>`. Returns null — so the caller falls back to
 * `inlineImgSvg` — when the source has no `<svg>` root, no usable coordinate
 * system, or any feature that isn't safely flattenable (see
 * {@link isSvgSafeToFlatten}). Emits a rect clip at the placement rect unless the
 * source sets `overflow: visible`, since a `<g>` (unlike a viewport) does not clip.
 */
export function flattenImgSvg(svgText: string, p: InlineSvgPlacement): string | null {
  const tag = /<svg\b([^>]*)>/i.exec(svgText);
  if (tag == null) return null;
  const attrs = tag[1];
  const rawBody = svgText.slice(tag.index + tag[0].length);
  // Drop a trailing `</svg>` (and anything after) so we emit only the children.
  const closeIdx = rawBody.toLowerCase().lastIndexOf("</svg>");
  const bodySource = closeIdx >= 0 ? rawBody.slice(0, closeIdx) : rawBody;

  if (!isSvgSafeToFlatten(bodySource)) return null;

  const viewBox = resolveViewBoxRect(attrs, p.intrinsic);
  if (viewBox == null) return null;
  const matrix = computeViewportMatrix({ x: p.x, y: p.y, w: p.w, h: p.h }, viewBox, parsePreserveAspectRatio(p.par));
  if (matrix == null) return null;

  // Namespace ids/classes exactly as the nested path does (DM-1588 / DM-1593).
  let body = prefixSvgIds(bodySource, p.idPrefix);
  if (/<style[\s>]/i.test(svgText)) body = prefixSvgClasses(body, p.idPrefix);
  // Inheritable presentation properties + currentColor context on the root svg
  // must survive: carry a root `color`/`fill`/… by keeping the source svg's
  // presentation attrs on the group (strip layout attrs it must not carry).
  const groupAttrs = prefixSvgIds(
    stripAttrs(attrs, [
      "x",
      "y",
      "width",
      "height",
      "viewBox",
      "preserveAspectRatio",
      "xmlns",
      "xmlns:xlink",
      "version",
      "overflow",
    ]),
    p.idPrefix,
  ).replace(/\s+$/, "");

  // The `r()` px formatter rounds to 1 decimal — fine for coordinates but far
  // too coarse for the scale/skew components (0.6667 would round to 0.7, a ~5%
  // scale error). Use 6-decimal precision for the whole matrix.
  const mf = (n: number): string => Number(n.toFixed(6)).toString();
  const m = `matrix(${mf(matrix.a)} ${mf(matrix.b)} ${mf(matrix.c)} ${mf(matrix.d)} ${mf(matrix.e)} ${mf(matrix.f)})`;
  const group = `<g${groupAttrs} transform="${m}">${body}</g>`;

  // A nested `<svg>` clips to its viewport (overflow:hidden default); a `<g>`
  // does not. Add a rect clip at the placement rect unless overflow is visible.
  const overflowVisible = /\boverflow\s*=\s*["']?\s*visible/i.test(attrs) || /\boverflow\s*:\s*visible/i.test(attrs);
  if (overflowVisible) return group;
  const clipId = `${p.idPrefix}vclip`;
  return (
    `<clipPath id="${clipId}"><rect x="${r(p.x)}" y="${r(p.y)}" width="${r(p.w)}" height="${r(p.h)}"/></clipPath>` +
    `<g clip-path="url(#${clipId})">${group}</g>`
  );
}
