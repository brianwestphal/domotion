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
 * alone.
 */
import { evaluateMediaQueryList } from "./svg-image-media.js";
import { renderWarn } from "./render-warn.js";

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
): string {
  let out = "";
  let cursor = start;
  let i = start;
  while (i < end) {
    const brace = clean.indexOf("{", i);
    const semi = clean.indexOf(";", i);
    if (brace < 0 || brace >= end) break;
    const prelude = clean.slice(i, brace);
    const trimmed = prelude.trim();
    if (trimmed.startsWith("@") && semi >= 0 && semi < brace) {
      i = semi + 1; // block-less at-rule
      continue;
    }
    const close = blockEnd(clean, brace);
    if (trimmed.startsWith("@")) {
      const name = /^@([-\w]+)/.exec(trimmed)?.[1].toLowerCase() ?? "";
      if (GROUP_AT_RULES.has(name)) {
        const inner = scopeRules(css, clean, brace + 1, close - 1, scope, viewport);
        // An image sheet's `@media` sees the image viewport, not the output
        // document's: decide it now and freeze the answer.
        const matches =
          name === "media" && viewport != null ? evaluateMediaQueryList(trimmed.slice(6), viewport) : null;
        if (name === "media" && matches == null) {
          renderWarn(
            "svg-image-sheet-media",
            `<img> svg @media query "${trimmed.slice(6).trim()}" cannot be evaluated against the image viewport; the output document's viewport decides it`,
            "<img> svg",
          );
        }
        const lead = prelude.length - prelude.trimStart().length;
        const head =
          matches == null
            ? css.slice(cursor, brace + 1)
            : `${css.slice(cursor, i + lead)}@media ${matches ? "all" : "not all"} {`;
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
      i++;
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
function replaceRoot(selector: string, rootSel: string): string {
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
      out += rewriteStructural(name, null, rootSel) ?? m[0];
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
    out += rewriteStructural(name, inner, rootSel) ?? `:${m[1]}(${replaceRoot(inner, rootSel)})`;
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
function rewriteStructural(name: string, args: string | null, rootSel: string): string | null {
  if (args == null) {
    if (name === "root" || name === "scope") return rootSel;
    if (/^(?:first|last|only)-(?:child|of-type)$/.test(name)) return `:is(:${name}, ${rootSel})`;
    return null;
  }
  if (!/^nth-(?:last-)?(?:child|of-type)$/.test(name)) return null;
  const ofMatch = /^([\s\S]*?)\s+of\s+([\s\S]+)$/i.exec(args);
  const anb = (ofMatch?.[1] ?? args).trim();
  const ofSelector = ofMatch != null && name.endsWith("child") ? replaceRoot(ofMatch[2], rootSel) : null;
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
function scopeCompound(compound: string, filter: string, scope: string): string {
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
  if (top.includes(`.${scope}`) || top.includes(`#${scope}`)) return compound;
  // A pseudo-element (`::x`, or a legacy single-colon one) ends the compound.
  const pe = /::|:(?:before|after|first-line|first-letter)\b/i.exec(compound);
  return pe == null ? compound + filter : compound.slice(0, pe.index) + filter + compound.slice(pe.index);
}

/** Scope every complex selector of a selector list. */
export function scopeSelectorList(selectorList: string, scope: string): string {
  const rootSel = `[${IMAGE_ROOT_ATTR}="${scope}"]`;
  const filter = `:where(${rootSel}, ${rootSel} *)`;
  return splitTopLevel(selectorList, (ch) => ch === ",")
    .map(({ part, sep }) => {
      const selector = replaceRoot(part, rootSel);
      const lead = selector.match(/^\s*/)?.[0] ?? "";
      const tail = selector.match(/\s*$/)?.[0] ?? "";
      const body = selector.trim();
      if (body === "") return part + sep;
      // Compounds are separated by combinators: whitespace, `>`, `+`, `~`.
      const pieces = splitTopLevel(body, (ch) => ch === ">" || ch === "+" || ch === "~" || /\s/.test(ch));
      const scoped = pieces
        .map(({ part: compound, sep: comb }) => scopeCompound(compound, filter, scope) + comb)
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
): string {
  return markup.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_m, open: string, css: string, close: string) => {
    return open + scopeRules(css, blankNoise(css), 0, css.length, scope, viewport) + close;
  });
}
