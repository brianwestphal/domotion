/** CSS Syntax token boundaries for image import/resource admission.
 * Reuse the image reference decoder; never classify strings/comments by a raw @ regex. */
import {
  cssWhitespace,
  referenceCssEscapeEnd,
  referenceCssIdentifier,
  referenceCssString,
  referenceCssStringValue,
} from "./svg-image-reference-syntax.js";
import { imageCssUrlArgument } from "./svg-image-reference-css.js";

export function cssImportTriviaEnd(text: string, from: number): number | null {
  let at = from;
  while (at < text.length) {
    if (cssWhitespace(text[at])) {
      at++;
      continue;
    }
    if (!text.startsWith("/*", at)) break;
    const end = text.indexOf("*/", at + 2);
    if (end < 0) return null;
    at = end + 2;
  }
  return at;
}
/** CSSTokenizer::ConsumeIdentLikeToken/ConsumeUrlToken (7d859f27): quoted
 * function strings and unquoted URL tokens have distinct whitespace rules. */
export function cssImportUrl(text: string, from: number): { value: string; end: number } | null {
  const string = referenceCssString(text, from);
  if (string != null) return string;
  const ident = referenceCssIdentifier(text, from);
  if (ident?.value.toLowerCase() !== "url" || text[ident.end] !== "(") return null;
  return imageCssUrlArgument(text, ident.end);
}
export function cssImportBlock(text: string, start: number): { content: string; end: number } | null {
  if (text[start] !== "(") return null;
  let depth = 1;
  for (let at = start + 1; at < text.length;) {
    if (text.startsWith("/*", at)) {
      const end = text.indexOf("*/", at + 2);
      if (end < 0) return null;
      at = end + 2;
      continue;
    }
    if (text[at] === '"' || text[at] === "'") {
      const string = referenceCssString(text, at);
      if (string == null) return null;
      at = string.end;
      continue;
    }
    if (text[at] === "\\") {
      const end = referenceCssEscapeEnd(text, at);
      if (end == null) return null;
      at = end;
      continue;
    }
    if (text[at] === "(") depth++;
    else if (text[at] === ")" && --depth === 0) return { content: text.slice(start + 1, at), end: at + 1 };
    at++;
  }
  return null;
}

/** Canonicalize only real top-level import at-keywords. PostCSS splits a hex
 * escape's optional whitespace between node.name and params; normalize before
 * that split. Nested/unknown escaped rule syntax remains source-owned. */
export function imageImportKeywords(
  css: string,
): { text: string; hasImport: boolean; changed: boolean; unsupported: boolean } | null {
  let at = 0,
    braces = 0,
    parens = 0,
    statement = true,
    out = "",
    copied = 0,
    hasImport = false,
    changed = false,
    unsupported = false;
  while (at < css.length) {
    if (statement && braces === 0 && parens === 0 && (css.startsWith("<!--", at) || css.startsWith("-->", at))) {
      out += css.slice(copied, at);
      at += css.startsWith("<!--", at) ? 4 : 3;
      copied = at;
      changed = true;
      continue;
    }
    if (css.startsWith("/*", at)) {
      const end = css.indexOf("*/", at + 2);
      if (end < 0) return null;
      at = end + 2;
      continue;
    }
    if (css[at] === '"' || css[at] === "'") {
      const string = referenceCssString(css, at);
      if (string == null) return null;
      at = string.end;
      statement = false;
      continue;
    }
    if (css[at] === "@") {
      const ident = referenceCssIdentifier(css, at + 1);
      if (ident != null) {
        const escaped = css.slice(at + 1, ident.end).includes("\\");
        if (ident.value.toLowerCase() === "import" && statement && parens === 0) {
          if (braces !== 0) {
            unsupported = true;
            at = ident.end;
            statement = false;
            continue;
          }
          hasImport = true;
          if (escaped) {
            out += css.slice(copied, at) + "@import";
            copied = ident.end;
            changed = true;
          }
        } else if (escaped && statement && braces === 0 && parens === 0) unsupported = true;
        at = ident.end;
        statement = false;
        continue;
      }
    }
    const ident = referenceCssIdentifier(css, at);
    if (ident != null) {
      if (ident.value.toLowerCase() === "url" && css[ident.end] === "(") {
        const url = cssImportUrl(css, at);
        if (url == null) return null;
        at = url.end;
      } else at = ident.end;
      statement = false;
      continue;
    }
    const ch = css[at++];
    if (ch === "{") {
      braces++;
      statement = true;
    } else if (ch === "}") {
      if (braces === 0) return null;
      braces--;
      statement = true;
    } else if (ch === "(") {
      parens++;
      statement = false;
    } else if (ch === ")") {
      if (parens === 0) return null;
      parens--;
      statement = false;
    } else if (ch === ";" && parens === 0) statement = true;
    else if (!cssWhitespace(ch)) statement = false;
  }
  return braces === 0 && parens === 0 ? { text: out + css.slice(copied), hasImport, changed, unsupported } : null;
}

/** Declaration URL tokens only. Strings remain data; dynamic image functions
 * and unknown escaped non-URL identifiers retain the conservative fallback. */
export function rewriteImportedCssUrls(
  value: string,
  authorize: (url: string, raw: string) => string | null,
  stringData: (decoded: string) => void,
): string | null {
  let out = "",
    at = 0;
  while (at < value.length) {
    if (value.startsWith("/*", at)) {
      const end = value.indexOf("*/", at + 2);
      if (end < 0) return null;
      out += value.slice(at, end + 2);
      at = end + 2;
      continue;
    }
    if (value[at] === '"' || value[at] === "'") {
      const string = referenceCssString(value, at);
      if (string == null) return null;
      stringData(string.value);
      out += value.slice(at, string.end);
      at = string.end;
      continue;
    }
    const ident = referenceCssIdentifier(value, at);
    if (ident == null) {
      if (value[at] === "\\") return null;
      out += value[at++];
      continue;
    }
    const rawName = value.slice(at, ident.end),
      name = ident.value.toLowerCase();
    if (value[ident.end] !== "(") {
      if (rawName.includes("\\")) return null;
      out += rawName;
      at = ident.end;
      continue;
    }
    if (["image-set", "-webkit-image-set", "src", "image"].includes(name)) return null;
    if (name !== "url") {
      if (rawName.includes("\\")) return null;
      out += rawName + "(";
      at = ident.end + 1;
      continue;
    }
    const token = cssImportUrl(value, at);
    if (token == null) return null;
    const raw = value.slice(at, token.end),
      authorized = authorize(token.value, raw);
    if (authorized == null) return null;
    out += raw.includes("\\") ? `url(${referenceCssStringValue(authorized)})` : raw;
    at = token.end;
  }
  return out;
}
