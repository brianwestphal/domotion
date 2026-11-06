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

import { esc, formatNumberLoose, r } from "./format.js";
import {
  computeViewportMatrix,
  parsePreserveAspectRatio,
  type AffineMatrix,
  type ViewBox,
} from "./svg-viewport-matrix.js";
import { invokeSynchronousCallback, type SynchronousCallback } from "./text-engine.js";
import { resolveImageRootTransform, type ResolvedImageRootTransform } from "./svg-image-root-transform.js";
import { renderWarn } from "./render-warn.js";
import { flatCssBlocks, replaceFlatCssBlocks } from "../utils/flat-css-blocks.js";

export interface SvgOpeningTag {
  start: number;
  end: number;
  name: string;
  attributes: string;
  raw: string;
}

/** Locate an opening tag without mistaking a quoted `>` for its end. */
export function readSvgOpeningTag(markup: string, name = "svg", from = 0): SvgOpeningTag | null {
  const matcher = new RegExp(`<${name}\\b`, "gi");
  matcher.lastIndex = from;
  const startMatch = matcher.exec(markup);
  if (startMatch == null) return null;
  const start = startMatch.index;
  let quote: "'" | '"' | null = null;
  for (let index = startMatch.index + startMatch[0].length; index < markup.length; index++) {
    const ch = markup[index];
    if (quote != null) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return {
        start,
        end: index + 1,
        name,
        attributes: markup.slice(startMatch.index + startMatch[0].length, index),
        raw: markup.slice(start, index + 1),
      };
    }
  }
  return null;
}

export interface SvgAttributeToken {
  name: string;
  value: string;
  start: number;
  end: number;
}

/** Tokenize XML attributes; fail closed on malformed or unsupported syntax. */
export function parseSvgAttributes(attributes: string): SvgAttributeToken[] | null {
  const tokens: SvgAttributeToken[] = [];
  let index = 0;
  while (index < attributes.length) {
    const start = index;
    while (/\s/.test(attributes[index] ?? "")) index++;
    if (index === attributes.length) break;
    if (attributes.slice(index).trim() === "/") break;
    const nameMatch = /^[A-Za-z_:][-A-Za-z0-9_:.]*/.exec(attributes.slice(index));
    if (nameMatch == null || index === start) return null;
    const name = nameMatch[0];
    index += name.length;
    while (/\s/.test(attributes[index] ?? "")) index++;
    if (attributes[index++] !== "=") return null;
    while (/\s/.test(attributes[index] ?? "")) index++;
    const quote = attributes[index];
    if (quote === '"' || quote === "'") {
      index++;
      const close = attributes.indexOf(quote, index);
      if (close < 0) return null;
      tokens.push({ name, value: attributes.slice(index, close), start, end: close + 1 });
      index = close + 1;
    } else {
      const valueStart = index;
      while (index < attributes.length && !/\s/.test(attributes[index])) index++;
      if (index === valueStart) return null;
      tokens.push({ name, value: attributes.slice(valueStart, index), start, end: index });
    }
  }
  return tokens;
}

/** Read or edit only the root SVG's attributes, preserving untouched markup. */
export function svgRootAttribute(markup: string, name: string): string | null {
  return svgOpeningTagAttribute(markup, "svg", name);
}

export function svgOpeningTagAttribute(markup: string, tagName: string, name: string): string | null {
  const root = readSvgOpeningTag(markup, tagName);
  const tokens = root != null ? parseSvgAttributes(root.attributes) : null;
  return tokens?.find((token) => token.name.toLowerCase() === name.toLowerCase())?.value ?? null;
}

export function editSvgRootAttributes(
  markup: string,
  remove: readonly string[],
  set: Readonly<Record<string, string>> = {},
): string {
  return editSvgOpeningTagAttributes(markup, "svg", remove, set);
}

export function editSvgOpeningTagAttributes(
  markup: string,
  tagName: string,
  remove: readonly string[],
  set: Readonly<Record<string, string>> = {},
): string {
  const root = readSvgOpeningTag(markup, tagName);
  if (root == null) return markup;
  const selfClosing = /\/\s*$/.test(root.attributes);
  const sourceAttrs = selfClosing ? root.attributes.replace(/\/\s*$/, "") : root.attributes;
  const tokens = parseSvgAttributes(sourceAttrs);
  if (tokens == null) return markup;
  const removed = new Set([...remove, ...Object.keys(set)].map((name) => name.toLowerCase()));
  let attrs = sourceAttrs;
  for (const token of [...tokens].reverse()) {
    if (removed.has(token.name.toLowerCase())) attrs = attrs.slice(0, token.start) + attrs.slice(token.end);
  }
  const appended = Object.entries(set)
    // `esc`, not a bespoke `&`/`"` escape: XML forbids a literal `<` in an
    // attribute value, and an illegal code point would make the document malformed.
    .map(([name, value]) => ` ${name}="${esc(value)}"`)
    .join("");
  return (
    markup.slice(0, root.start) + `<${tagName}${attrs}${appended}${selfClosing ? " /" : ""}>` + markup.slice(root.end)
  );
}

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
      replaceFlatCssBlocks(
        css,
        (selectors, body) =>
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
    const rewritten = replaceFlatCssBlocks(
      css,
      (sel, block) => sel.replace(/\.(-?[_a-zA-Z][-_a-zA-Z0-9]*)/g, (_c, name: string) => `.${prefix}${name}`) + block,
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
  const v = parseSvgAttributes(attrs)
    ?.find((token) => token.name.toLowerCase() === name.toLowerCase())
    ?.value.trim();
  if (v == null) return null;
  if (/%$/.test(v)) return null; // percentage widths have no absolute coordinate system
  const n = parseFloat(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Extract the root `<svg>`'s `viewBox` value (inner string), or null. */
function extractViewBox(attrs: string): string | null {
  const vb = parseSvgAttributes(attrs)
    ?.find((token) => token.name.toLowerCase() === "viewbox")
    ?.value.trim();
  if (vb == null) return null;
  return vb === "" ? null : vb;
}

/** Serialize a numeric viewBox for a `viewBox` attribute. */
function formatViewBox(v: ViewBox): string {
  const f = (n: number): string => formatNumberLoose(n, 6);
  return `${f(v.minX)} ${f(v.minY)} ${f(v.width)} ${f(v.height)}`;
}

/** Remove the given attributes (case-insensitive names) from a `<svg>` tag's
 *  attribute string, so the caller can re-declare them. */
function stripAttrs(attrs: string, names: string[]): string {
  const tokens = parseSvgAttributes(attrs);
  if (tokens == null) return attrs;
  const removed = new Set(names.map((name) => name.toLowerCase()));
  let out = attrs;
  for (const token of [...tokens].reverse()) {
    if (removed.has(token.name.toLowerCase())) out = out.slice(0, token.start) + out.slice(token.end);
  }
  return out;
}

/** Root `<svg>` attributes a flattened `<g>` must NOT carry: the viewport and
 *  layout attributes the viewport matrix replaces, namespace/version
 *  declarations, the viewport-only `overflow`, and the transform family (the
 *  group's own `transform` holds the viewport matrix, so keeping the root's
 *  would emit a duplicate attribute). The root's own transform is not lost:
 *  see `imageRootTransform` for where each path applies it. */
const FLATTENED_ROOT_DROPPED_ATTRS = [
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
  "transform",
  "transform-origin",
  "transform-box",
];

/**
 * The root `<svg>`'s CSS transform for an `<img>` SVG document, resolved about
 * its transform origin against the concrete object rect `box`, or null when
 * the root has none.
 *
 * Blink (chromium 7d859f27): `SVGSVGElement` is an `SVGTransformableElement`,
 * whose `transform` attribute is a presentation attribute for the CSS
 * `transform` property (`core/svg/svg_transformable_element.cc:38-41, 50-52`).
 * The outermost `<svg>` is laid out as `LayoutSVGRoot`, a CSS replaced box, so
 * the transform applies to that box like any CSS transform: a root `style`
 * `transform`, the individual `translate` / `rotate` / `scale` properties and
 * `transform-origin` (attribute or style) all apply, about the initial
 * `transform-origin: 50% 50%`. See `resolveImageRootTransform` for the
 * composition and its sources.
 *
 * - A DOM-inline `<svg>`: capture already records Blink's resolved transform as
 *   the element's CSS transform (applied by the renderer's wrapper group) and
 *   neutralizes the attribute, so the inlined markup must NOT apply it again.
 * - The document root of an `<img>` SVG image: nothing else applies it, so the
 *   `<img>` paths compose it around the resolved origin
 *   ({@link applyImageRootTransform}) and clip the result to the image box.
 *
 * A declaration the resolver cannot express exactly (`calc()`, font-relative
 * units, a 3D function) falls back to the `transform` attribute alone about
 * the box center, with a named warning.
 */
function imageRootTransform(attrs: string, box: Rect, slot: string): ResolvedImageRootTransform | null {
  const tokens = parseSvgAttributes(attrs) ?? [];
  const attr = (name: string): string | null =>
    tokens.find((token) => token.name.toLowerCase() === name)?.value ?? null;
  const style = new Map<string, string>();
  const styleText = attr("style");
  if (styleText != null) {
    for (const declaration of splitStyleDeclarations(styleText)) {
      const colon = declaration.indexOf(":");
      if (colon < 0) continue;
      const value = declaration
        .slice(colon + 1)
        .replace(/!\s*important\s*$/i, "")
        .trim();
      style.set(declaration.slice(0, colon).trim().toLowerCase(), value);
    }
  }
  const transformAttr = attr("transform");
  const resolved = resolveImageRootTransform(
    { transformAttr, transformOriginAttr: attr("transform-origin"), style },
    box,
  );
  if (resolved !== "unsupported") return resolved;
  renderWarn(
    "svg-image-root-transform",
    `${slot} root transform uses a value that cannot be resolved exactly; only its transform attribute is applied`,
    slot,
  );
  const fallback = resolveImageRootTransform({ transformAttr, transformOriginAttr: null, style: new Map() }, box);
  return fallback === "unsupported" ? null : fallback;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The viewBox mapped through the viewport matrix (an axis-aligned scale +
 *  translate) — the concrete object rect the root box occupies in the `<img>`. */
function mappedViewBoxRect(viewBox: ViewBox, m: AffineMatrix): Rect {
  const x0 = m.a * viewBox.minX + m.e;
  const y0 = m.d * viewBox.minY + m.f;
  const x1 = m.a * (viewBox.minX + viewBox.width) + m.e;
  const y1 = m.d * (viewBox.minY + viewBox.height) + m.f;
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
}

/**
 * Clip `content` to the drawn image: `SVGImage::DrawInternal` always clips to
 * its destination rect before drawing the frame
 * (`core/svg/graphics/svg_image.cc:548`, chromium 7d859f27), whatever the
 * root's `overflow`. The clip is the placement (content) box intersected with
 * the concrete object rect: the object rect is smaller for `object-fit:
 * contain`, the content box for `cover`. A Chromium probe confirms both an
 * `overflow="visible"` root drawn at the image box and a `contain` image
 * clipped to its object rect inside a wider content box.
 */
function clipToImage(content: string, p: InlineSvgPlacement, object: Rect): string {
  const x0 = Math.max(p.x, object.x);
  const y0 = Math.max(p.y, object.y);
  const x1 = Math.min(p.x + p.w, object.x + object.w);
  const y1 = Math.min(p.y + p.h, object.y + object.h);
  const clipId = `${p.idPrefix}vclip-img`;
  return (
    `<clipPath id="${clipId}"><rect x="${r(x0)}" y="${r(y0)}" width="${r(Math.max(0, x1 - x0))}" height="${r(Math.max(0, y1 - y0))}"/></clipPath>` +
    `<g clip-path="url(#${clipId})">${content}</g>`
  );
}

/**
 * Wrap `content` (the root box's markup, viewport mapping included) in the
 * root's transform, applied about its resolved origin, and clip the result to
 * the drawn image ({@link clipToImage}).
 */
function applyImageRootTransform(
  content: string,
  root: ResolvedImageRootTransform,
  p: InlineSvgPlacement,
  object: Rect,
): string {
  const f = (n: number): string => formatNumberLoose(n, 6);
  const { x: cx, y: cy } = root.origin;
  return clipToImage(
    `<g transform="translate(${f(cx)} ${f(cy)}) ${root.transform} translate(${f(-cx)} ${f(-cy)})">${content}</g>`,
    p,
    object,
  );
}

/** Whether the root `<svg>` sets `overflow: visible` (attribute or style). */
function rootOverflowVisible(attrs: string): boolean {
  return /\boverflow\s*=\s*["']?\s*visible/i.test(attrs) || /\boverflow\s*:\s*visible/i.test(attrs);
}

/** Whether the concrete object rect leaves part of the placement box uncovered
 *  (`object-fit: contain` / `scale-down`), so the root viewport's own clip at
 *  the placement box is wider than the drawn image. */
function objectInsetFromPlacement(p: InlineSvgPlacement, object: Rect): boolean {
  const eps = 1e-6;
  return (
    object.x > p.x + eps ||
    object.y > p.y + eps ||
    object.x + object.w < p.x + p.w - eps ||
    object.y + object.h < p.y + p.h - eps
  );
}

/**
 * The attribute string (with its leading space, trailing space trimmed) that a
 * flattened `<g>` keeps from the root `<svg>` it replaces. Inheritable
 * presentation attributes on the root (`fill`, `stroke`, `font-family`, `color`,
 * …), its `class`/`style`, and accessibility attributes must survive so the
 * children inherit and match exactly what they did under the nested `<svg>`.
 * DM-97E2CN: the DOM-inline flatten path previously dropped all of them, so the
 * root `font-family` capture bakes from the page cascade vanished and SVG text
 * fell back to the serif default.
 */
export function flattenedRootGroupAttributes(rootAttrs: string): string {
  const kept = stripAttrs(rootAttrs, FLATTENED_ROOT_DROPPED_ATTRS);
  const tokens = parseSvgAttributes(kept);
  const style = tokens?.find((token) => token.name.toLowerCase() === "style");
  if (style == null) return kept.replace(/\s+$/, "");
  const declarations = stripViewportOnlyStyleDeclarations(style.value);
  const replacement = declarations === "" ? "" : ` style="${declarations.replace(/"/g, "&quot;")}"`;
  return (kept.slice(0, style.start) + replacement + kept.slice(style.end)).replace(/\s+$/, "");
}

/** CSS properties a flattened group must not inherit from the root's `style`.
 *  DM-KDGVCN: capture neutralizes the DOM root's own transform on the clone
 *  (`transform:translate(0);rotate:none;scale:none;translate:none`), because the
 *  renderer applies the element's transform outside the SVG. On the nested
 *  `<svg>` that is inert, but on the flattened `<g>` a CSS `transform` overrides
 *  the group's `transform` presentation attribute, the viewport matrix, and
 *  collapses the content onto the origin. `overflow` only means something on a
 *  viewport, and the group's clip replaces it. */
const FLATTENED_ROOT_DROPPED_STYLE_PROPS = new Set([
  "transform",
  "rotate",
  "scale",
  "translate",
  "transform-origin",
  "transform-box",
  "overflow",
]);

/** Remove {@link FLATTENED_ROOT_DROPPED_STYLE_PROPS} from a `style` attribute value. */
function stripViewportOnlyStyleDeclarations(style: string): string {
  return stripStyleProperties(style, FLATTENED_ROOT_DROPPED_STYLE_PROPS);
}

/** The transform-family properties an `<img>` root's composed transform replaces. */
const IMAGE_ROOT_TRANSFORM_STYLE_PROPS = new Set([
  "transform",
  "rotate",
  "scale",
  "translate",
  "transform-origin",
  "transform-box",
]);

/** Remove the declarations of `properties` from a `style` attribute value. */
function stripStyleProperties(style: string, properties: ReadonlySet<string>): string {
  return splitStyleDeclarations(style)
    .filter((declaration) => {
      const colon = declaration.indexOf(":");
      return !properties.has((colon < 0 ? declaration : declaration.slice(0, colon)).trim().toLowerCase());
    })
    .join(";");
}

/** Split a `style` attribute value into its trimmed, non-empty declarations.
 *  Splits on `;` outside quotes, parentheses and character entities, so
 *  `url("data:…;…")` and `&quot;Helvetica Neue&quot;` stay intact. */
function splitStyleDeclarations(style: string): string[] {
  const declarations: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i <= style.length; i++) {
    const ch = style[i];
    if (i < style.length) {
      if (quote != null) {
        if (ch === quote) quote = null;
        continue;
      }
      // The value is raw attribute text, so `&quot;` and friends end in `;`.
      const entity = ch === "&" ? /^&(?:#\d+|#x[\da-f]+|[a-z]+);/i.exec(style.slice(i)) : null;
      if (entity != null) {
        i += entity[0].length - 1;
        continue;
      }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "(") depth++;
      else if (ch === ")") depth = Math.max(0, depth - 1);
      if (ch !== ";" || depth > 0) continue;
    }
    const declaration = style.slice(start, i).trim();
    start = i + 1;
    if (declaration !== "") declarations.push(declaration);
  }
  return declarations;
}

/** `attrs` without the root transform family: the `transform` and
 *  `transform-origin` attributes and the matching `style` declarations. */
function stripImageRootTransformAttrs(attrs: string): string {
  const stripped = stripAttrs(attrs, ["transform", "transform-origin"]);
  const style = parseSvgAttributes(stripped)?.find((token) => token.name.toLowerCase() === "style");
  if (style == null) return stripped;
  const declarations = stripStyleProperties(style.value, IMAGE_ROOT_TRANSFORM_STYLE_PROPS);
  const replacement = declarations === "" ? "" : ` style="${declarations.replace(/"/g, "&quot;")}"`;
  return stripped.slice(0, style.start) + replacement + stripped.slice(style.end);
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
  /**
   * The placement rect is the `<img>`'s concrete object rect, which Blink uses
   * as the SVG image document's viewport: `ImagePainter` asks for the image at
   * `dest_rect.size` (`core/paint/image_painter.cc:218`), `SVGImage` lays the
   * root out at that container size (`core/svg/graphics/svg_image.cc:463`),
   * and the root's own viewBox / preserveAspectRatio map the content into it.
   * A valid root viewBox therefore maps with the ROOT's preserveAspectRatio
   * (default `xMidYMid meet`), never a stretch derived from object-fit; without
   * one Blink synthesizes a viewBox from the root's width/height resolved
   * against the viewport and a `none` preserveAspectRatio
   * (`SVGSVGElement::CurrentViewBoxRect` / `CurrentPreserveAspectRatio`,
   * `core/svg/svg_svg_element.cc:598-626`, chromium 7d859f27). The drawn image
   * (its clip and the root transform's reference box) is the placement rect.
   * `par` is ignored when set.
   */
  documentViewport?: boolean;
  /** The `<img>`'s effective zoom (CSS px per SVG user unit for a synthesized
   *  viewport-relative viewBox); used with `documentViewport`. Defaults to 1. */
  zoom?: number;
}

/** A root `<svg>` length attribute resolved against the image viewport
 *  dimension `viewport` (user units): an absolute length, a percentage of the
 *  viewport, or the `100%` initial value when absent or unparseable. */
function resolveViewportLength(attrs: string, name: string, viewport: number): number {
  const v = parseSvgAttributes(attrs)
    ?.find((token) => token.name.toLowerCase() === name)
    ?.value.trim();
  if (v != null) {
    const pct = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)%$/i.exec(v);
    if (pct != null) return (parseFloat(pct[1]) / 100) * viewport;
    const n = parseFloat(v);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return viewport;
}

/**
 * The viewBox and preserveAspectRatio an `<img>` SVG document maps into its
 * viewport `p` (see {@link InlineSvgPlacement.documentViewport}). Null when no
 * non-empty coordinate system results.
 */
function resolveDocumentViewport(
  attrs: string,
  p: InlineSvgPlacement,
): { viewBox: ViewBox; viewBoxAttr: string; par: string } | null {
  const own = resolveViewBoxRect(attrs, null, true);
  if (own != null) {
    const parAttr = parseSvgAttributes(attrs)
      ?.find((token) => token.name.toLowerCase() === "preserveaspectratio")
      ?.value.trim();
    const parsed = parsePreserveAspectRatio(parAttr ?? null);
    return {
      viewBox: own,
      viewBoxAttr: extractViewBox(attrs) ?? formatViewBox(own),
      par: `${parsed.align} ${parsed.meetOrSlice}`,
    };
  }
  const zoom = p.zoom != null && Number.isFinite(p.zoom) && p.zoom > 0 ? p.zoom : 1;
  const width = resolveViewportLength(attrs, "width", p.w / zoom);
  const height = resolveViewportLength(attrs, "height", p.h / zoom);
  if (!(width > 0) || !(height > 0)) return null;
  const viewBox = { minX: 0, minY: 0, width, height };
  return { viewBox, viewBoxAttr: formatViewBox(viewBox), par: "none" };
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
  const tag = readSvgOpeningTag(svgText);
  if (tag == null) return null;
  let attrs = tag.attributes;

  const doc = p.documentViewport === true ? resolveDocumentViewport(attrs, p) : null;
  if (p.documentViewport === true && doc == null) return null;
  const par = doc?.par ?? p.par;
  // Resolve a coordinate system: the SVG's own viewBox, else one synthesized
  // from its absolute width/height, else from the <img> intrinsic size.
  let viewBox = doc == null ? extractViewBox(attrs) : doc.viewBoxAttr;
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

  const rect = doc?.viewBox ?? resolveViewBoxRect(tag.attributes, p.intrinsic);
  const matrix = rect == null ? null : computeViewportMatrix(p, rect, parsePreserveAspectRatio(par));
  // The drawn image: the document viewport itself, else the viewBox as the
  // object-fit-derived preserveAspectRatio maps it into the content box.
  const object = doc != null ? p : rect != null && matrix != null ? mappedViewBoxRect(rect, matrix) : p;
  // An `<img>` document root's own transform is composed outside the viewport
  // below (a nested `<svg transform>` would rotate about the output origin).
  const rootTransform = imageRootTransform(attrs, object, "<img> svg");
  if (rootTransform != null) attrs = stripImageRootTransformAttrs(attrs);
  // Strip the attrs we re-declare (keep xmlns / class / style / role / etc.).
  attrs = stripAttrs(attrs, ["x", "y", "width", "height", "viewBox", "preserveAspectRatio"]);
  // Namespace ids: the root tag's own attrs (a root `id`/`url(#…)` is rare but
  // legal) and the whole body (defs + references).
  let rootAttrs = prefixSvgIds(attrs, p.idPrefix).replace(/\s+$/, "");
  let body = prefixSvgIds(svgText.slice(tag.end), p.idPrefix);
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
    ` viewBox="${viewBox}" preserveAspectRatio="${par}">`;
  if (rootTransform != null) return applyImageRootTransform(open + body, rootTransform, p, object);
  // The nested viewport clips to the placement box, which equals the drawn
  // image only when the object rect covers it and overflow is not visible.
  if (rootOverflowVisible(tag.attributes) || objectInsetFromPlacement(p, object)) {
    return clipToImage(open + body, p, object);
  }
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
/**
 * Run `fn` with nested-SVG flattening forced to `enabled`, restoring the previous
 * setting afterward even if `fn` throws. Prefer this (or the `flattenNestedSvg`
 * render option) to the bare setter: the flag is process-global, so a setter call
 * that is not paired with a reset leaks into every later render in the process.
 * The callback must be synchronous: an async callback would see the flag
 * restored before its awaited work runs, so Promise-like results are rejected
 * at the type boundary and at runtime (the shared text-engine scope contract).
 */
export function withFlattenNestedSvg<F extends () => unknown>(
  enabled: boolean,
  fn: SynchronousCallback<F>,
): ReturnType<F> {
  const previous = flattenNestedSvgEnabled;
  flattenNestedSvgEnabled = enabled;
  try {
    return invokeSynchronousCallback("withFlattenNestedSvg", fn);
  } finally {
    flattenNestedSvgEnabled = previous;
  }
}

/** Resolve the source SVG's numeric viewBox (own viewBox, else synthesized from
 *  absolute width/height, else the `<img>` intrinsic size), or null. */
function resolveViewBoxRect(
  attrs: string,
  intrinsic?: { w: number; h: number } | null,
  viewBoxOnly = false,
): ViewBox | null {
  const vbStr = extractViewBox(attrs);
  if (vbStr != null) {
    const nums = vbStr
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    if (nums.length === 4 && nums.every((n) => Number.isFinite(n)) && nums[2] > 0 && nums[3] > 0) {
      return { minX: nums[0], minY: nums[1], width: nums[2], height: nums[3] };
    }
    return null;
  }
  if (viewBoxOnly) return null;
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
    for (const rule of flatCssBlocks(css, { nonEmptyPrelude: true })) {
      for (const selector of rule.prelude.split(",")) {
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
  const tag = readSvgOpeningTag(svgText);
  if (tag == null) return null;
  const attrs = tag.attributes;
  const rawBody = svgText.slice(tag.end);
  // Drop a trailing `</svg>` (and anything after) so we emit only the children.
  const closeIdx = rawBody.toLowerCase().lastIndexOf("</svg>");
  const bodySource = closeIdx >= 0 ? rawBody.slice(0, closeIdx) : rawBody;

  if (!isSvgSafeToFlatten(bodySource)) return null;

  const doc = p.documentViewport === true ? resolveDocumentViewport(attrs, p) : null;
  const viewBox = p.documentViewport === true ? (doc?.viewBox ?? null) : resolveViewBoxRect(attrs, p.intrinsic);
  if (viewBox == null) return null;
  const par = doc?.par ?? p.par;
  const matrix = computeViewportMatrix({ x: p.x, y: p.y, w: p.w, h: p.h }, viewBox, parsePreserveAspectRatio(par));
  if (matrix == null) return null;

  // Namespace ids/classes exactly as the nested path does (DM-1588 / DM-1593).
  let body = prefixSvgIds(bodySource, p.idPrefix);
  if (/<style[\s>]/i.test(svgText)) body = prefixSvgClasses(body, p.idPrefix);
  // Inheritable presentation properties + currentColor context on the root svg
  // must survive: carry a root `color`/`fill`/… by keeping the source svg's
  // presentation attrs on the group (strip layout attrs it must not carry).
  const groupAttrs = prefixSvgIds(flattenedRootGroupAttributes(attrs), p.idPrefix);

  // The `r()` px formatter rounds to 1 decimal — fine for coordinates but far
  // too coarse for the scale/skew components (0.6667 would round to 0.7, a ~5%
  // scale error). Use 6-decimal precision for the whole matrix.
  const mf = (n: number): string => formatNumberLoose(n, 6);
  const m = `matrix(${mf(matrix.a)} ${mf(matrix.b)} ${mf(matrix.c)} ${mf(matrix.d)} ${mf(matrix.e)} ${mf(matrix.f)})`;
  const group = `<g${groupAttrs} transform="${m}">${body}</g>`;

  // A nested `<svg>` clips to its viewport (overflow:hidden default); a `<g>`
  // does not. Add a rect clip at the placement rect unless overflow is
  // visible; the drawn-image clip applies either way.
  const object = doc != null ? { x: p.x, y: p.y, w: p.w, h: p.h } : mappedViewBoxRect(viewBox, matrix);
  const rootTransform = imageRootTransform(attrs, object, "<img> svg");
  if (rootOverflowVisible(attrs)) {
    return rootTransform == null
      ? clipToImage(group, p, object)
      : applyImageRootTransform(group, rootTransform, p, object);
  }
  const clipId = `${p.idPrefix}vclip`;
  const clipped =
    `<clipPath id="${clipId}"><rect x="${r(p.x)}" y="${r(p.y)}" width="${r(p.w)}" height="${r(p.h)}"/></clipPath>` +
    `<g clip-path="url(#${clipId})">${group}</g>`;
  if (rootTransform == null) return objectInsetFromPlacement(p, object) ? clipToImage(clipped, p, object) : clipped;
  // The root box's own clip moves with the root transform (it is inside it);
  // the `<img>` box clip does not.
  return applyImageRootTransform(clipped, rootTransform, p, object);
}
