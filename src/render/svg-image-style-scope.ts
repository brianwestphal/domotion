/**
 * Scope an inlined `<img>` SVG document's `<style>` sheets to that image.
 *
 * Blink gives every SVG image its own document (`SVGImage::DataChanged`
 * builds a separate `Page` + `Document`, `core/svg/graphics/svg_image.cc`,
 * chromium 7d859f27), so the image's author sheets reach only the image's own
 * elements and `:root` means the image root. Once the image is inlined as a
 * nested `<svg>`, its `<style>` elements belong to the output document and
 * would apply to every element there: an element selector such as
 * `g rect { stroke: #fff }` would stroke every rect in the output, and
 * `svg { … }` / `:root { … }` would reach the output's own root.
 *
 * The nested root carries `data-domotion-image-root="<prefix>"`, and every
 * selector is rewritten so each of its compounds must be that root or one of
 * its descendants (a compound that already requires one of the image's
 * namespaced classes or ids is confined as it stands) (`:where(<root>, <root> *)`, which adds no specificity, so
 * rules keep ranking against each other as they did in the image). `:root`
 * becomes the root attribute selector, which has the same specificity.
 * Conditional group rules (`@media`, `@supports`, `@layer`, `@container`,
 * `@scope`) are scoped recursively; other at-rules (`@font-face`,
 * `@keyframes`, `@page`, `@import`, …) carry no element selectors and are left
 * alone. Top-level cascade layer names gain the image's prefix, so each image
 * keeps its own layer order (`namespaceLayerNames`). `:has()` relative selectors
 * receive the same filter inside their argument: Blink's `CheckPseudoHas`
 * traverses following siblings for `+` and `~`, while an SVG image document
 * root has none (selector_checker.cc, chromium 7d859f27).
 */
import { evaluateMediaQueryList, type ImageMediaEnv } from "./svg-image-media.js";
import { renderWarn } from "./render-warn.js";
import { decideImageSupports } from "./svg-image-supports.js";

/** The attribute that identifies an inlined image root (value: its id prefix). */
export const IMAGE_ROOT_ATTR = "data-domotion-image-root";

const GROUP_AT_RULES = new Set(["media", "supports", "layer", "container", "scope", "document"]);

/** Blank comments, CDATA markers and HTML comment markers (same length), so
 *  parse positions index the original text. */
function blankNoise(css: string): string {
  const blank = (m: string): string => " ".repeat(m.length);
  return css
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/<!\[CDATA\[|\]\]>/g, blank)
    .replace(/<!--|-->/g, blank);
}

/** Index just past the `}` closing the block opened at `open`, or the text end. */
function blockEnd(css: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < css.length; i++) {
    const ch = css[i];
    if (quote != null) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i + 1;
  }
  return css.length;
}

/** Walk `[start, end)` of a sheet, scoping every qualified rule's prelude. */
function scopeRules(
  css: string,
  clean: string,
  start: number,
  end: number,
  scope: string,
  viewport: { w: number; h: number } | null,
  env: ImageMediaEnv,
  inLayer: boolean,
): string {
  let out = "";
  let cursor = start;
  let i = start;
  while (i < end) {
    const brace = clean.indexOf("{", i);
    const semi = clean.indexOf(";", i);
    // A trailing block-less at-rule has no `{` after it.
    const blockAt = brace < 0 || brace >= end ? end : brace;
    const prelude = clean.slice(i, blockAt);
    const trimmed = prelude.trim();
    if (trimmed.startsWith("@") && semi >= 0 && semi < blockAt) {
      // A block-less at-rule. An `@layer a, b;` statement or an
      // `@import … layer(a)` outside every layer names top-level layers,
      // which join the output document's one layer map once inlined.
      const statement = clean.slice(i, semi).trim();
      const renamed = inLayer ? null : namespaceLayerStatement(statement, scope);
      if (renamed != null) {
        const lead = prelude.length - prelude.trimStart().length;
        out += css.slice(cursor, i + lead) + renamed;
        cursor = semi;
      }
      i = semi + 1;
      continue;
    }
    if (blockAt === end) break;
    const close = blockEnd(clean, brace);
    if (trimmed.startsWith("@")) {
      const name = /^@([-\w]+)/.exec(trimmed)?.[1].toLowerCase() ?? "";
      if (GROUP_AT_RULES.has(name)) {
        const inner = scopeRules(css, clean, brace + 1, close - 1, scope, viewport, env, inLayer || name === "layer");
        // An image sheet's `@media` sees the image viewport, not the output
        // document's: decide it now and freeze the answer. An `@supports`
        // condition the page's Chromium decided at capture is frozen too.
        const matches =
          name === "media"
            ? evaluateMediaQueryList(trimmed.slice(6), viewport, env)
            : name === "supports"
              ? decideImageSupports(trimmed.slice(9), env.supports)
              : null;
        if (name === "media" && matches == null) {
          renderWarn(
            "svg-image-sheet-media",
            `<img> svg @media query "${trimmed.slice(6).trim()}" cannot be evaluated against the image viewport; the output document's viewport decides it`,
            "<img> svg",
          );
        }
        const lead = prelude.length - prelude.trimStart().length;
        const layerNames = name === "layer" && !inLayer ? trimmed.slice(6).trim() : "";
        const head =
          matches != null
            ? `${css.slice(cursor, i + lead)}@media ${matches ? "all" : "not all"} {`
            : layerNames !== ""
              ? `${css.slice(cursor, i + lead)}@layer ${namespaceLayerNames(layerNames, scope)} {`
              : css.slice(cursor, brace + 1);
        out += head + inner + "}";
        cursor = close;
      }
      i = close;
      continue;
    }
    const lead = prelude.length - prelude.trimStart().length;
    const trail = prelude.length - prelude.trimEnd().length;
    out += css.slice(cursor, i + lead) + scopeSelectorList(trimmed, scope) + css.slice(brace - trail, brace);
    cursor = brace;
    i = close;
  }
  return out + css.slice(cursor, end);
}

/**
 * Namespace the top-level cascade layer names of one image.
 *
 * Blink builds one `CascadeLayerMap` per tree scope from every active sheet,
 * and layers with the same name from different sheets are the same layer
 * (`CascadeLayerMap::CascadeLayerMap` / `AddLayers`, core/css/cascade_layer_map.cc:15-60,
 * chromium 7d859f27). The image's sheets lived in the image document's own
 * map; inlined, they join the output document's, where another image that
 * declares the same names in a different order would reorder this image's
 * layers (the merged order is first declaration across all sheets). Prefixing
 * the first segment of each name keeps every image's layers to itself and
 * keeps the image's own order. Sublayer names inside a layer block are
 * relative to it and stay as written; anonymous layers are always distinct.
 */
function namespaceLayerNames(list: string, scope: string): string {
  return list
    .split(",")
    .map((name) => {
      const trimmed = name.trim();
      return trimmed === "" ? name : `${scope}${trimmed}`;
    })
    .join(", ");
}

/** `@layer a, b` or `@import … layer(a)` with its names namespaced, or null. */
function namespaceLayerStatement(statement: string, scope: string): string | null {
  const layer = /^@layer\s+([\s\S]+)$/i.exec(statement);
  if (layer != null) return `@layer ${namespaceLayerNames(layer[1], scope)}`;
  if (!/^@import\b/i.test(statement)) return null;
  const fn = /\blayer\(\s*([^()]*?)\s*\)/i.exec(statement);
  if (fn == null || fn[1] === "") return null;
  return `${statement.slice(0, fn.index)}layer(${scope}${fn[1]})${statement.slice(fn.index + fn[0].length)}`;
}

/** Split on a top-level separator predicate, respecting strings, escapes and brackets. */
function splitTopLevel(text: string, isSeparator: (ch: string) => boolean): Array<{ part: string; sep: string }> {
  const parts: Array<{ part: string; sep: string }> = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote != null) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "\\") {
      // An escape, including the whitespace that ends a hex escape (CSS
      // Syntax §4.3.7), which is not a combinator.
      const hex = /^[0-9a-fA-F]{1,6}(?:\r\n|[ \t\n\r\f])?/.exec(text.slice(i + 1));
      i += hex != null ? hex[0].length : 1;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    else if (depth === 0 && isSeparator(ch)) {
      let j = i;
      while (j + 1 < text.length && isSeparator(text[j + 1])) j++;
      parts.push({ part: text.slice(start, i), sep: text.slice(i, j + 1) });
      start = j + 1;
      i = j;
    }
  }
  parts.push({ part: text.slice(start), sep: "" });
  return parts;
}

/** Replace `:root` (outside strings) with the scope root's attribute selector. */
function replaceRoot(selector: string, rootSel: string, scope: string, withinHas = false): string {
  let out = "";
  let i = 0;
  while (i < selector.length) {
    const ch = selector[i];
    if (ch === '"' || ch === "'") {
      const str = new RegExp(`^${ch}(?:\\\\.|[^${ch}\\\\])*${ch}`).exec(selector.slice(i));
      const len = str?.[0].length ?? selector.length - i;
      out += selector.slice(i, i + len);
      i += len;
      continue;
    }
    if (ch !== ":") {
      out += ch;
      i++;
      continue;
    }
    const m = /^:([-a-zA-Z]+)(\()?/.exec(selector.slice(i));
    const name = m?.[1].toLowerCase() ?? "";
    if (m == null || selector[i + 1] === ":") {
      // A pseudo-element (`::x`) passes through whole.
      const pe = /^::?[-a-zA-Z]+/.exec(selector.slice(i));
      out += pe?.[0] ?? ch;
      i += pe?.[0].length ?? 1;
      continue;
    }
    if (m[2] == null) {
      out += rewriteStructural(name, null, rootSel, scope, withinHas) ?? m[0];
      i += m[0].length;
      continue;
    }
    const open = i + m[0].length - 1;
    const close = matchParen(selector, open);
    if (close < 0) {
      out += selector.slice(i);
      break;
    }
    const inner = selector.slice(open + 1, close);
    // A relative :has() argument can walk to a following output sibling of
    // the nested image root. Filter every argument compound, including nested
    // logical selector lists, so it sees only the former image document.
    out +=
      rewriteStructural(name, inner, rootSel, scope, withinHas) ??
      `:${m[1]}(${name === "has" || (withinHas && /^(?:is|not|where)$/.test(name)) ? scopeSelectorList(inner, scope, true) : replaceRoot(inner, rootSel, scope, withinHas)})`;
    i = close + 1;
  }
  return out;
}

/**
 * In the image document the root is the document element: `:root` and
 * `:scope` (a document-scoped sheet's scope, `SelectorChecker::CheckPseudoScope`,
 * `core/css/selector_checker.cc:3644-3654`) mean it, and it has no element
 * siblings, so the child-indexed structural pseudo-classes see it as the only
 * child: `IsFirstChild` / `IsLastChild` find no sibling (`selector_checker.cc:476-486`)
 * and `NthIndexCache::NthChildIndex` counts index 1 (`core/dom/nth_index_cache.cc:148`),
 * chromium 7d859f27. Inlined, the nested root does have siblings, so each such
 * pseudo-class is rewritten to give the root its image-document answer while
 * every other element keeps the original test. Returns null for anything else.
 */
function rewriteStructural(
  name: string,
  args: string | null,
  rootSel: string,
  scope: string,
  withinHas: boolean,
): string | null {
  if (args == null) {
    if (name === "root" || name === "scope") return rootSel;
    if (/^(?:first|last|only)-(?:child|of-type)$/.test(name)) return `:is(:${name}, ${rootSel})`;
    return null;
  }
  if (!/^nth-(?:last-)?(?:child|of-type)$/.test(name)) return null;
  const ofMatch = /^([\s\S]*?)\s+of\s+([\s\S]+)$/i.exec(args);
  const anb = (ofMatch?.[1] ?? args).trim();
  const ofSelector =
    ofMatch != null && name.endsWith("child")
      ? withinHas
        ? scopeSelectorList(ofMatch[2], scope, true)
        : replaceRoot(ofMatch[2], rootSel, scope)
      : null;
  if (ofMatch != null && ofSelector == null) return null;
  const firstMatches = anPlusBMatches(anb, 1);
  if (firstMatches == null) return null;
  const pc = `:${name}(${anb}${ofSelector != null ? ` of ${ofSelector}` : ""})`;
  // `:not(:where(…))` adds no specificity.
  if (!firstMatches) return `${pc}:not(:where(${rootSel}))`;
  return ofSelector == null ? `:is(${pc}, ${rootSel})` : `:is(${pc}, ${rootSel}:is(${ofSelector}))`;
}

/** Whether the An+B microsyntax matches index `index` (null when unparseable). */
export function anPlusBMatches(text: string, index: number): boolean | null {
  const t = text.replace(/\s+/g, "").toLowerCase();
  let a: number;
  let b: number;
  if (t === "odd") [a, b] = [2, 1];
  else if (t === "even") [a, b] = [2, 0];
  else {
    const m = /^([-+]?\d*)n([-+]\d+)?$/.exec(t);
    if (m != null) {
      a = m[1] === "" || m[1] === "+" ? 1 : m[1] === "-" ? -1 : Number(m[1]);
      b = m[2] == null ? 0 : Number(m[2]);
    } else if (/^[-+]?\d+$/.test(t)) [a, b] = [0, Number(t)];
    else return null;
  }
  if (a === 0) return index === b;
  const n = (index - b) / a;
  return Number.isInteger(n) && n >= 0;
}

/** Index of the `)` matching the `(` at `open`, respecting strings, or -1. */
function matchParen(s: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (quote != null) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return i;
  }
  return -1;
}

/** Scope one compound selector: insert the scope filter before any pseudo-element. */
function scopeCompound(compound: string, filter: string, scope: string, withinHas: boolean): string {
  if (compound === "") return compound;
  // A compound that requires one of this image's namespaced classes or ids
  // (`prefixSvgClasses` / `prefixSvgIds` ran first) already matches only
  // this image's elements; leave it as it is. Only top-level tokens count:
  // `:not(.x)` does not confine.
  let top = compound;
  for (let prev = ""; prev !== top;) {
    prev = top;
    top = top.replace(/\([^()]*\)/g, "");
  }
  if (!withinHas && (top.includes(`.${scope}`) || top.includes(`#${scope}`))) return compound;
  // A pseudo-element (`::x`, or a legacy single-colon one) ends the compound.
  const pe = /::|:(?:before|after|first-line|first-letter)\b/i.exec(compound);
  return pe == null ? compound + filter : compound.slice(0, pe.index) + filter + compound.slice(pe.index);
}

/** Scope every complex selector of a selector list. */
export function scopeSelectorList(selectorList: string, scope: string, withinHas = false): string {
  const rootSel = `[${IMAGE_ROOT_ATTR}="${scope}"]`;
  const filter = `:where(${rootSel}, ${rootSel} *)`;
  return splitTopLevel(selectorList, (ch) => ch === ",")
    .map(({ part, sep }) => {
      const selector = replaceRoot(part, rootSel, scope, withinHas);
      const lead = selector.match(/^\s*/)?.[0] ?? "";
      const tail = selector.match(/\s*$/)?.[0] ?? "";
      const body = selector.trim();
      if (body === "") return part + sep;
      // Compounds are separated by combinators: whitespace, `>`, `+`, `~`.
      const pieces = splitTopLevel(body, (ch) => ch === ">" || ch === "+" || ch === "~" || /\s/.test(ch));
      const scoped = pieces
        .map(({ part: compound, sep: comb }) => scopeCompound(compound, filter, scope, withinHas) + comb)
        .join("");
      return lead + scoped + tail + sep;
    })
    .join("");
}

/** Scope every `<style>` sheet in `markup` to the image root tagged with `scope`. */
export function scopeImageStyleSheets(
  markup: string,
  scope: string,
  viewport: { w: number; h: number } | null = null,
  env: ImageMediaEnv = {},
): string {
  return markup.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_m, open: string, css: string, close: string) => {
    return open + scopeRules(css, blankNoise(css), 0, css.length, scope, viewport, env, false) + close;
  });
}
