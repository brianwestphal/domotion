import postcss from "postcss";
import { cssUnescape } from "./svg-image-selector-engine.js";
import {
  cssWhitespace,
  referenceCssEscapeEnd,
  referenceCssIdentifier,
  referenceCssIdentifierValue,
  referenceCssString,
  referenceCssStringValue,
  referenceLocalFragment,
} from "./svg-image-reference-syntax.js";

export interface ImageReferenceContext {
  prefix: string;
  ids: ReadonlySet<string>;
  originals: ReadonlyMap<string, string>;
}

export const IMAGE_SVG_RESOURCE_PROPERTIES: ReadonlySet<string> = new Set([
  "fill",
  "stroke",
  "filter",
  "clip-path",
  "mask",
  "mask-image",
  "marker-start",
  "marker-mid",
  "marker-end",
]);

/** A local fragment names an actual image-owned target; unknown targets retain
 * the source fallback instead of acquiring an output-document target. */
export function rewriteImageLocalUrl(value: string, context: ImageReferenceContext): string | null {
  const fragment = referenceLocalFragment(value);
  if (fragment == null || fragment === "" || !context.ids.has(fragment)) return null;
  return "#" + encodeURIComponent(context.prefix + fragment);
}

function commentEnd(value: string, at: number): number | null {
  const close = value.indexOf("*/", at + 2);
  return close < 0 ? null : close + 2;
}

/** Consume the CSS url token's argument without interpreting ordinary strings
 * as resources. Bad-URL tokens and modifiers remain source-owned. */
function urlArgument(value: string, open: number): { end: number; value: string } | null {
  let at = open + 1;
  while (cssWhitespace(value[at] ?? "")) at++;
  if (value[at] === '"' || value[at] === "'") {
    const string = referenceCssString(value, at);
    if (string == null) return null;
    at = string.end;
    while (cssWhitespace(value[at] ?? "")) at++;
    return value[at] === ")" ? { end: at + 1, value: string.value } : null;
  }
  const start = at;
  while (at < value.length && value[at] !== ")" && !cssWhitespace(value[at])) {
    if (/["'(\x00-\x08\x0b\x0e-\x1f\x7f]/.test(value[at])) return null;
    if (value[at] === "\\") {
      const end = referenceCssEscapeEnd(value, at);
      if (end == null) return null;
      at = end;
    } else at++;
  }
  const raw = value.slice(start, at);
  while (cssWhitespace(value[at] ?? "")) at++;
  if (value[at] !== ")") return null;
  // Use the same escape decoder as identifiers/strings, after preserving URL
  // whitespace and token boundaries above.
  return { end: at + 1, value: cssUnescape(raw) };
}

/** Declarations only: quoted data/comments stay literal; actual URL functions
 * and attr() reads of attributes whose values change are token-aware. */
export function rewriteImageCssValue(value: string, property: string, context: ImageReferenceContext): string | null {
  let out = "";
  for (let at = 0; at < value.length;) {
    if (value.startsWith("/*", at)) {
      const end = commentEnd(value, at);
      if (end == null) return null;
      out += value.slice(at, end);
      at = end;
      continue;
    }
    if (value[at] === '"' || value[at] === "'") {
      const string = referenceCssString(value, at);
      if (string == null) return null;
      out += value.slice(at, string.end);
      at = string.end;
      continue;
    }
    const identifier = referenceCssIdentifier(value, at);
    if (identifier == null) {
      out += value[at++];
      continue;
    }
    const name = identifier.value.toLowerCase();
    if (value[identifier.end] !== "(") {
      out += value.slice(at, identifier.end);
      at = identifier.end;
      continue;
    }
    if (name === "url") {
      const argument = urlArgument(value, identifier.end);
      if (argument == null) return null;
      if (argument.value.startsWith("#")) {
        if (!IMAGE_SVG_RESOURCE_PROPERTIES.has(property.toLowerCase())) return null;
        const rewritten = rewriteImageLocalUrl(argument.value, context);
        if (rewritten == null) return null;
        out += `url(${referenceCssStringValue(rewritten)})`;
      } else if (/^data:/i.test(argument.value)) out += value.slice(at, argument.end);
      else return null;
      at = argument.end;
      continue;
    }
    if (name === "attr") {
      let start = identifier.end + 1;
      while (cssWhitespace(value[start] ?? "")) start++;
      const attribute = referenceCssIdentifier(value, start);
      if (attribute?.value.includes(":") || value[attribute?.end ?? start] === "|") return null;
      const original = attribute == null ? undefined : context.originals.get(attribute.value);
      if (original != null) {
        out += value.slice(at, start) + original;
        at = attribute!.end;
        continue;
      }
    }
    out += value.slice(at, identifier.end + 1);
    at = identifier.end + 1;
  }
  return out;
}

function attributeSelectorEnd(value: string, start: number): number | null {
  for (let at = start + 1; at < value.length;) {
    if (value.startsWith("/*", at)) {
      const end = commentEnd(value, at);
      if (end == null) return null;
      at = end;
      continue;
    }
    if (value[at] === '"' || value[at] === "'") {
      const string = referenceCssString(value, at);
      if (string == null) return null;
      at = string.end;
      continue;
    }
    if (value[at] === "\\") {
      const end = referenceCssEscapeEnd(value, at);
      if (end == null) return null;
      at = end;
      continue;
    }
    if (value[at] === "]") return at + 1;
    if (value[at] === "[") return null;
    at++;
  }
  return null;
}

/** Hash/class tokens are identities; strings and attribute comparison values
 * are data. Original-value attributes preserve all comparison operators and
 * specificity without fitting selectors to the current matched node set. */
export function rewriteImageSelector(selector: string, context: ImageReferenceContext): string | null {
  let out = "";
  for (let at = 0; at < selector.length;) {
    if (selector.startsWith("/*", at)) {
      const end = commentEnd(selector, at);
      if (end == null) return null;
      out += selector.slice(at, end);
      at = end;
      continue;
    }
    if (selector[at] === '"' || selector[at] === "'") {
      const string = referenceCssString(selector, at);
      if (string == null) return null;
      out += selector.slice(at, string.end);
      at = string.end;
      continue;
    }
    if (selector[at] === "[") {
      const end = attributeSelectorEnd(selector, at);
      if (end == null) return null;
      let start = at + 1;
      while (cssWhitespace(selector[start] ?? "")) start++;
      const name = referenceCssIdentifier(selector, start);
      if (name == null || name.value.includes(":")) return null;
      let tail = name.end;
      while (cssWhitespace(selector[tail] ?? "")) tail++;
      if (selector[tail] === "|" && selector[tail + 1] !== "=") return null;
      const original = context.originals.get(name.value);
      out +=
        original == null
          ? selector.slice(at, end)
          : selector.slice(at, start) + original + selector.slice(name.end, end);
      at = end;
      continue;
    }
    if (selector[at] === "#" || selector[at] === ".") {
      const identifier = referenceCssIdentifier(selector, at + 1);
      if (identifier == null) return null;
      out += selector[at] + referenceCssIdentifierValue(context.prefix + identifier.value);
      at = identifier.end;
      continue;
    }
    if (selector[at] === "\\") {
      const end = referenceCssEscapeEnd(selector, at);
      if (end == null) return null;
      out += selector.slice(at, end);
      at = end;
      continue;
    }
    out += selector[at++];
  }
  return out;
}

const SAFE_GROUP_RULES = new Set([
  "media",
  "supports",
  "container",
  "layer",
  "starting-style",
  "keyframes",
  "-webkit-keyframes",
  "font-face",
  "font-feature-values",
  "font-palette-values",
  "counter-style",
  "property",
  "charset",
]);

export function rewriteImageStyleSheet(css: string, context: ImageReferenceContext): string | null {
  try {
    const root = postcss.parse(css);
    let safe = true;
    root.walkAtRules((rule) => {
      if (!SAFE_GROUP_RULES.has(rule.name.toLowerCase())) safe = false;
    });
    root.walkRules((rule) => {
      if (rule.parent?.type === "atrule" && /^(?:-webkit-)?keyframes$/i.test(rule.parent.name)) return;
      const rewritten = rewriteImageSelector(rule.selector, context);
      if (rewritten == null) safe = false;
      else rule.selector = rewritten;
    });
    root.walkDecls((decl) => {
      const rewritten = rewriteImageCssValue(decl.value, decl.prop, context);
      if (rewritten == null) safe = false;
      else decl.value = rewritten;
    });
    return safe ? root.toString() : null;
  } catch {
    return null;
  }
}

export function rewriteImageInlineStyle(css: string, context: ImageReferenceContext): string | null {
  try {
    const root = postcss.parse(`e{${css}}`);
    if (root.nodes.length !== 1 || root.first?.type !== "rule") return null;
    const rule = root.first;
    let safe = true;
    if (rule.nodes.some((node) => node.type !== "decl" && node.type !== "comment")) return null;
    rule.walkDecls((decl) => {
      const rewritten = rewriteImageCssValue(decl.value, decl.prop, context);
      if (rewritten == null) safe = false;
      else decl.value = rewritten;
    });
    const result = rule.toString();
    return safe ? result.slice(result.indexOf("{") + 1, -1) : null;
  } catch {
    return null;
  }
}
