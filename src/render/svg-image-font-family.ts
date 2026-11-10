import { blankImageCssNoise } from "./svg-image-cdata.js";
import { CSS_ESCAPE, cssUnescape } from "./svg-image-selector-engine.js";

/** Blink's ConsumeGenericFamily range, css_value_keywords.json5 / Chromium7d859f27. */
const GENERICS = new Set([
  "serif",
  "sans-serif",
  "cursive",
  "fantasy",
  "monospace",
  "system-ui",
  "-webkit-body",
  "math",
]);
const WIDE = new Set(["initial", "inherit", "unset", "revert", "revert-layer", "revert-rule", "default"]);
const IDENT = new RegExp(
  `^(?:--|-?(?:[_a-zA-Z]|[^\\x00-\\x7f]|${CSS_ESCAPE}))(?:[-_a-zA-Z0-9]|[^\\x00-\\x7f]|${CSS_ESCAPE})*`,
);
const SPACE = /^[ \t\n\r\f]$/;
export const trimImageCssWhitespace = (value: string): string => value.replace(/^[ \t\n\r\f]+|[ \t\n\r\f]+$/g, "");

/** End of a valid CSS escape; null for EOF/newline escapes in identifiers. */
export function imageCssEscapeEnd(value: string, start: number): number | null {
  let at = start + 1;
  if (at >= value.length || /[\n\r\f]/.test(value[at])) return null;
  if (/[0-9a-f]/i.test(value[at])) {
    let count = 0;
    while (at < value.length && count++ < 6 && /[0-9a-f]/i.test(value[at])) at++;
    if (SPACE.test(value[at] ?? "")) {
      if (value[at] === "\r" && value[at + 1] === "\n") at++;
      at++;
    }
    return at;
  }
  return at + 1;
}

export interface ImageFontFamily {
  /** Equivalent authored CSS, with comments removed and identifier gaps normalized. */
  css: string;
  /** Decoded family spelling. Quoted strings keep their data. */
  name: string;
  generic: boolean;
}

/** ConsumeFontFamily / ConsumeFamilyName / ConcatenateFamilyName, pinned
 * css_parsing_utils.cc:6302–6375. A generic consumes exactly one identifier;
 * literals consume one string or an identifier sequence. Wide/default words
 * are forbidden only as a lone unquoted family. Whole-tail consumption is
 * required: numbers, delimiters, functions and mixed strings are not names. */
export function parseImageFontFamilyTail(value: string): ImageFontFamily[] | null {
  if (value.length > 65536) return null;
  const text = blankImageCssNoise(value, false);
  const families: ImageFontFamily[] = [];
  let at = 0,
    budget = 512;
  const space = (): void => {
    while (SPACE.test(text[at] ?? "")) at++;
  };
  const identifier = (): string | null => {
    if (--budget < 0) return null;
    const match = IDENT.exec(text.slice(at));
    if (match == null) return null;
    at += match[0].length;
    return match[0];
  };
  for (;;) {
    space();
    const start = at;
    const quote = text[at];
    let family: ImageFontFamily;
    if (quote === '"' || quote === "'") {
      at++;
      while (at < text.length && text[at] !== quote) {
        if (/[\n\r\f]/.test(text[at])) return null;
        if (text[at] === "\\") {
          if (text[at + 1] === "\r" || text[at + 1] === "\n" || text[at + 1] === "\f") {
            at += text[at + 1] === "\r" && text[at + 2] === "\n" ? 3 : 2;
            continue;
          }
          const end = imageCssEscapeEnd(text, at);
          if (end == null) return null;
          at = end;
        } else at++;
      }
      if (text[at++] !== quote) return null;
      const css = text.slice(start, at);
      family = { css, name: cssUnescape(css.slice(1, -1)), generic: false };
    } else {
      const first = identifier();
      if (first == null) return null;
      const name = cssUnescape(first);
      const generic = GENERICS.has(name.toLowerCase());
      const words = [first];
      space();
      if (!generic) {
        for (;;) {
          const word = identifier();
          if (word == null) break;
          words.push(word);
          space();
        }
        if (words.length === 1 && WIDE.has(name.toLowerCase())) return null;
      }
      family = {
        css: generic ? name.toLowerCase() : words.join(" "),
        name: generic ? name.toLowerCase() : words.map(cssUnescape).join(" "),
        generic,
      };
      // CSSOM-only engine readers infer this internal UA name as a generic.
      // Blink's authored-family consumer treats it as a literal, so retain
      // that distinction with an equivalent quoted spelling.
      if (!generic && family.name.toLowerCase() === "-webkit-standard") family.css = `"${family.name}"`;
    }
    // The renderer's CSSOM family reader trims decoded outer whitespace.
    // Keep unusual authored names unresolved instead of changing their face.
    if (family.name !== family.name.trim()) return null;
    families.push(family);
    space();
    if (at === text.length) return families;
    if (text[at++] !== "," || budget <= 0) return null;
  }
}
