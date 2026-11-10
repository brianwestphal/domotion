import { cssUnescape } from "./svg-image-selector-engine.js";
import { esc } from "./format.js";

const ESCAPE = "\\\\(?:[0-9a-fA-F]{1,6}(?:\\r\\n|[ \\t\\n\\r\\f])?|[^\\n\\r\\f0-9a-fA-F])";
const IDENT = new RegExp(`^(?:--|-?(?:[_a-zA-Z]|[^\\x00-\\x7f]|${ESCAPE}))(?:[-_a-zA-Z0-9]|[^\\x00-\\x7f]|${ESCAPE})*`);
export const cssWhitespace = (value: string): boolean => /^[ \t\n\r\f]$/.test(value);

export function referenceCssIdentifier(value: string, start: number): { end: number; value: string } | null {
  const match = IDENT.exec(value.slice(start));
  return match == null ? null : { end: start + match[0].length, value: cssUnescape(match[0]) };
}

export function referenceCssEscapeEnd(value: string, start: number): number | null {
  const match = new RegExp(`^${ESCAPE}`).exec(value.slice(start));
  return match == null ? null : start + match[0].length;
}

/** A complete CSS string token; newlines must be escaped continuations. */
export function referenceCssString(value: string, start: number): { end: number; value: string } | null {
  const quote = value[start];
  if (quote !== '"' && quote !== "'") return null;
  let at = start + 1;
  while (at < value.length && value[at] !== quote) {
    if (/[\n\r\f]/.test(value[at])) return null;
    if (value[at] === "\\") {
      if (/[\n\r\f]/.test(value[at + 1] ?? "")) {
        at += value[at + 1] === "\r" && value[at + 2] === "\n" ? 3 : 2;
        continue;
      }
      const end = referenceCssEscapeEnd(value, at);
      if (end == null) return null;
      at = end;
    } else at++;
  }
  return value[at] === quote ? { end: at + 1, value: cssUnescape(value.slice(start + 1, at)) } : null;
}

export function referenceCssStringValue(value: string): string {
  return (
    '"' +
    value
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/[\n\r\f]/g, (ch) => `\\${ch.codePointAt(0)!.toString(16)} `) +
    '"'
  );
}

/** CSS.escape's identifier rules, preserving specificity and token boundaries. */
export function referenceCssIdentifierValue(value: string): string {
  let out = "";
  const points = [...value];
  for (let index = 0; index < points.length; index++) {
    const ch = points[index],
      cp = ch.codePointAt(0)!;
    if (cp === 0) out += "�";
    else if (cp < 32 || cp === 127 || (/\d/.test(ch) && (index === 0 || (index === 1 && points[0] === "-"))))
      out += `\\${cp.toString(16)} `;
    else if (ch === "-" && points.length === 1) out += "\\-";
    else if (cp >= 128 || /[-_a-zA-Z0-9]/.test(ch)) out += ch;
    else out += "\\" + ch;
  }
  return out;
}

/** XML literal whitespace normalization differs from character references. */
export function referenceXmlAttributeValue(value: string): string {
  return esc(value).replace(/\t/g, "&#x9;").replace(/\n/g, "&#xA;").replace(/\r/g, "&#xD;");
}

/** SVGURIReference/CSSURIValue use KURL normalization then UTF8-or-isomorphic
 * percent decoding (url_util.cc:833–890, Chromium7d859f27). Invalid escapes
 * remain literal; any invalid UTF8 makes the whole byte sequence isomorphic. */
export function referenceLocalFragment(value: string): string | null {
  if (!value.startsWith("#")) return null;
  let fragment: string;
  try {
    fragment = new URL(value, "https://svg-image.invalid/").hash.slice(1);
  } catch {
    return null;
  }
  const bytes: number[] = [];
  for (let at = 0; at < fragment.length; at++) {
    if (fragment[at] === "%" && /^[0-9a-f]{2}$/i.test(fragment.slice(at + 1, at + 3))) {
      bytes.push(parseInt(fragment.slice(at + 1, at + 3), 16));
      at += 2;
    } else bytes.push(fragment.charCodeAt(at));
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Uint8Array.from(bytes));
  } catch {
    return Buffer.from(bytes).toString("latin1");
  }
}
