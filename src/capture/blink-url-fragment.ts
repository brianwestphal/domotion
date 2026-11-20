/**
 * Blink's external CSS SVG fragment identity, transcribed at Chromium pin
 * 7d859f27. Pure Node helpers: the capture prepass sends computed values here
 * and returns the decoded IDs to its page-context lookup.
 */

export type ExternalCssSvgProperty = "clip-path" | "mask-image";

export interface ExternalCssSvgUrlReference {
  /** Absolute resource URL without its fragment. */
  href: string;
  /** Canonical (URL-parser) fragment spelling, without `#`. */
  fragment: string;
  /** The element ID Blink passes to `getElementById` in the resource document. */
  id: string;
  /** Offset and length of the whole `url(…)` token in the computed value. */
  start: number;
  length: number;
}

function isHex(code: number): boolean {
  return (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66);
}

/**
 * `url::DecodeUrlEscapeSequences(input, DecodeUrlMode::kUtf8OrIsomorphic)`
 * (`url/url_util.cc:833-891`), reached through Blink's
 * `DecodeUrlEscapeSequences` (`platform/weborigin/kurl.cc:780-784`), which
 * first encodes the string as UTF-8. A `%` not followed by two hex digits is
 * kept literally. The unescaped bytes are decoded as UTF-8; if any sequence is
 * invalid, the whole result reverts to the isomorphic (byte -> U+00XX) reading,
 * including a valid prefix.
 */
export function decodeUrlEscapeSequencesUtf8OrIsomorphic(input: string): string {
  const source = new TextEncoder().encode(input);
  const bytes: number[] = [];
  for (let index = 0; index < source.length; index++) {
    const byte = source[index];
    if (byte === 0x25 && index + 2 < source.length && isHex(source[index + 1]) && isHex(source[index + 2])) {
      bytes.push(Number.parseInt(String.fromCharCode(source[index + 1], source[index + 2]), 16));
      index += 2;
    } else bytes.push(byte);
  }
  const unescaped = Uint8Array.from(bytes);
  if (unescaped.every((byte) => byte < 0x80)) return String.fromCharCode(...unescaped);
  try {
    // ignoreBOM: Chromium appends U+FEFF like any other code point.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(unescaped);
  } catch {
    let isomorphic = "";
    for (const byte of unescaped) isomorphic += String.fromCharCode(byte);
    return isomorphic;
  }
}

/**
 * The resource-document element ID Blink resolves for an external reference.
 *
 * - `clip-path` (`CSSURIValue::EnsureResourceReference` ->
 *   `ExternalSVGResourceDocumentContent::ResolveTarget`, `svg_resource.cc:347-349`)
 *   decodes the KURL fragment once.
 * - `mask-image` (`ElementStyleResources::LoadMaskSource`,
 *   `element_style_resources.cc:373-390`) builds its resource from
 *   `CSSImageValue::NormalizedFragmentIdentifier()`, which is already decoded
 *   (`css_image_value.cc:152-157`, `:189-194`), and
 *   `ExternalSVGResourceImageContent::ResolveTarget` (`svg_resource.cc:391-394`)
 *   decodes it again. So `#%2541` names `A` for a mask but `%41` for a clip.
 */
export function externalCssSvgFragmentId(property: ExternalCssSvgProperty, fragment: string): string {
  const once = decodeUrlEscapeSequencesUtf8OrIsomorphic(fragment);
  return property === "mask-image" ? decodeUrlEscapeSequencesUtf8OrIsomorphic(once) : once;
}

function isWhitespace(char: string | undefined): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f";
}

/** Consume a CSS escape after `\` (CSS Syntax 3 §4.3.7). Returns [text, nextIndex]. */
function consumeEscape(value: string, index: number): [string, number] {
  let hex = "";
  while (hex.length < 6 && index < value.length && isHex(value.charCodeAt(index))) hex += value[index++];
  if (hex !== "") {
    if (isWhitespace(value[index])) index++;
    const code = Number.parseInt(hex, 16);
    const valid = code !== 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
    return [String.fromCodePoint(valid ? code : 0xfffd), index];
  }
  if (index >= value.length) return ["�", index];
  const codePoint = value.codePointAt(index)!;
  const char = String.fromCodePoint(codePoint);
  return [char, index + char.length];
}

/**
 * Tokenize every `url(…)` in a computed `clip-path` / `mask-image` value.
 * Chromium serializes computed URLs as quoted CSS strings, so the URL may
 * legitimately contain `)` or `'` (the URL parser does not percent-encode
 * them in a fragment); a character-class regex truncates such references.
 */
export function tokenizeCssUrls(value: string): Array<{ url: string; start: number; length: number }> {
  const tokens: Array<{ url: string; start: number; length: number }> = [];
  let index = 0;
  while (index < value.length) {
    const char = value[index];
    if (char === '"' || char === "'") {
      // Skip a string outside url(), e.g. inside an unrelated function.
      index++;
      while (index < value.length && value[index] !== char) index += value[index] === "\\" ? 2 : 1;
      index++;
      continue;
    }
    if (value.slice(index, index + 4).toLowerCase() !== "url(" || /[\w-]/.test(value[index - 1] ?? "")) {
      index++;
      continue;
    }
    const start = index;
    index += 4;
    while (isWhitespace(value[index])) index++;
    let url = "";
    let closed = false;
    const quote = value[index];
    if (quote === '"' || quote === "'") {
      index++;
      while (index < value.length && value[index] !== quote) {
        if (value[index] === "\\") {
          if (value[index + 1] === "\n") {
            index += 2;
            continue;
          }
          const [text, next] = consumeEscape(value, index + 1);
          url += text;
          index = next;
        } else url += value[index++];
      }
      if (value[index] !== quote) break;
      index++;
      while (isWhitespace(value[index])) index++;
      closed = value[index] === ")";
    } else {
      while (index < value.length && value[index] !== ")") {
        if (isWhitespace(value[index])) {
          while (isWhitespace(value[index])) index++;
          break;
        }
        if (value[index] === "\\") {
          const [text, next] = consumeEscape(value, index + 1);
          url += text;
          index = next;
        } else url += value[index++];
      }
      closed = value[index] === ")";
    }
    if (!closed) break;
    index++;
    tokens.push({ url, start, length: index - start });
  }
  return tokens;
}

/**
 * External (cross-document) fragment references in a computed value, with the
 * Blink element ID for each. A reference is local, and excluded, when its
 * specified URL starts with `#` or equals the document URL ignoring the
 * fragment (`CSSUrlData::IsLocal`, `css_url_data.cc:92`, `:231-234`). A
 * reference without a fragment names no resource element and is excluded.
 */
export function externalCssSvgReferences(
  property: ExternalCssSvgProperty,
  computed: string,
  baseUrl: string,
  documentUrl: string,
): ExternalCssSvgUrlReference[] {
  const here = new URL(documentUrl);
  here.hash = "";
  const references: ExternalCssSvgUrlReference[] = [];
  for (const token of tokenizeCssUrls(computed)) {
    if (token.url.startsWith("#")) continue;
    let url: URL;
    try {
      url = new URL(token.url, baseUrl);
    } catch {
      // The existing walker owns invalid references.
      continue;
    }
    const fragment = url.hash.slice(1);
    url.hash = "";
    if (url.href === here.href || fragment === "") continue;
    references.push({
      href: url.href,
      fragment,
      id: externalCssSvgFragmentId(property, fragment),
      start: token.start,
      length: token.length,
    });
  }
  return references;
}
