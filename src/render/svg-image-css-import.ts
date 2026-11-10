import postcss, { type AtRule, type Root } from "postcss";
import {
  imageStyleSheets,
  replaceImageStyleSheets,
  serializeImageStyleText,
  xmlStyleText,
} from "./svg-image-stylesheets.js";
import { cssUnescape, parseImageElementTree } from "./svg-image-selector-engine.js";
import { imageFragmentInventory, type ImageFragmentInventory } from "./svg-image-fragment-ids.js";

export { xmlStyleText } from "./svg-image-stylesheets.js";

const MAX_IMPORT_DEPTH = 4;
const MAX_CSS_BYTES = 256_000;

const VERIFIED_ENCODINGS = new Set(["utf-8", "windows-1252", "iso-8859-1", "us-ascii", "utf-16le", "utf-16be"]);

interface DecodedCss {
  text: string;
  encoding: string;
}

function percentBytes(text: string): Buffer {
  const parts: Buffer[] = [];
  let start = 0;
  const pattern = /%[0-9a-f]{2}/gi;
  for (const match of text.matchAll(pattern)) {
    parts.push(Buffer.from(text.slice(start, match.index), "utf8"), Buffer.from([parseInt(match[0].slice(1), 16)]));
    start = match.index + 3;
  }
  parts.push(Buffer.from(text.slice(start), "utf8"));
  return Buffer.concat(parts);
}

/** net::DataURL::Parse, CSSStyleSheetResource::CanUseSheet and
 * TextResourceDecoder::{CheckForBOM,CheckForCSSCharset} (7d859f27). */
function dataCss(url: string, inheritedEncoding: string): DecodedCss | null {
  let canonical: string;
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    canonical = parsed.href;
  } catch {
    return null;
  }
  const match = /^data:([^,]*),([\s\S]*)$/i.exec(canonical);
  if (match == null) return null;
  const parts = match[1].split(";").map((part) => part.trim());
  const mime = parts[0].toLowerCase();
  // These response MIME types are the only data sheets Blink accepts in an
  // SVG image's strict CSS context. A rejected sheet still reserves its layer.
  if (mime !== "text/css" && mime !== "application/x-unknown-content-type")
    return { text: "", encoding: inheritedEncoding };
  const charsets = parts
    .slice(1)
    .filter((part) => /^charset=/i.test(part))
    .map((part) => part.slice(8));
  // The parameter-preserving DataURL parser validates later charset tokens
  // even after selecting the first nonempty label. Keep only simple tokens
  // whose validity is shared by both parsing paths; quoted labels stay raster.
  if (charsets.some((label) => label !== "" && !/^[a-z0-9_.-]+$/i.test(label))) return null;
  const charset = charsets.find((label) => label !== "");
  // Chromium has shipped both legacy and last-parameter-only base64 flags.
  // Do not guess when a launch feature flag could change these bytes.
  if (parts.slice(1, -1).some((part) => part.toLowerCase() === "base64")) return null;
  let bytes = percentBytes(match[2]);
  if (parts.at(-1)?.toLowerCase() === "base64") {
    let base64 = bytes.toString("latin1").replace(/[\t\n\f\r ]/g, "");
    if (base64.length % 4 === 0) base64 = base64.replace(/={1,2}$/, "");
    if (base64.length % 4 === 1 || /[^a-z0-9+/]/i.test(base64)) return null;
    bytes = Buffer.from(base64, "base64");
  }
  if (bytes.length > MAX_CSS_BYTES) return null;
  let encoding: string;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) encoding = "utf-8";
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = "utf-16le";
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = "utf-16be";
  else {
    encoding = charset || inheritedEncoding;
    if (!charset) {
      const declaration = /^@charset "([^"]*)";/.exec(bytes.toString("latin1"));
      if (declaration != null) {
        try {
          if (!VERIFIED_ENCODINGS.has(declaration[1].toLowerCase())) return null;
          const label = new TextDecoder(declaration[1]).encoding;
          // CSS's in-band declaration uses ClosestByteBasedEquivalent.
          encoding = label === "utf-16le" || label === "utf-16be" ? "utf-8" : label;
        } catch {
          return null;
        }
      }
    }
  }
  try {
    // Invalid bytes and unsupported labels stay raster-backed instead of
    // guessing a platform decoder's replacement behavior.
    if (!VERIFIED_ENCODINGS.has(encoding.toLowerCase())) return null;
    const decoder = new TextDecoder(encoding, { fatal: true });
    const text = decoder
      .decode(bytes)
      .replace(/\r\n?|\f/g, "\n")
      .replace(/\0/g, "�");
    return Buffer.byteLength(text, "utf8") <= MAX_CSS_BYTES ? { text, encoding: decoder.encoding } : null;
  } catch {
    return null;
  }
}

/** Independent data resources cannot acquire the host document's base URL.
 * Keep escaped/dynamic/relative URLs, image-set strings and noncanonical data
 * payloads conservative; later SVG namespace passes scan the serialized text. */
const SVG_RESOURCE_PROPERTIES = new Set([
  "fill",
  "stroke",
  "filter",
  "clip-path",
  "marker-start",
  "marker-mid",
  "marker-end",
  "mask",
  "mask-image",
]);

interface ResourceContext {
  inventory: ImageFragmentInventory | null;
  hasLocalReference: boolean;
  unrewritableString: boolean;
}

/** The current class prefixer cannot preserve escapes or attribute/string
 * selector data. DM-WT73T4 replaces this limited namespace mechanism. */
function selectorsRewritable(root: Root): boolean {
  let safe = true;
  root.walkRules((rule) => {
    if (/[\\\[\]"']/.test(rule.selector)) safe = false;
  });
  return safe;
}

/** Text/data that the shared regex namespace pass could accidentally edit. */
function namespaceSensitiveData(value: string): boolean {
  return /\bid\s*=['"]|\b(?:href|xlink:href)\s*=['"]#|url\(\s*['"]?#|\b(?:aria-activedescendant|aria-controls|aria-describedby|aria-details|aria-errormessage|aria-flowto|aria-labelledby|aria-owns|for|begin|end)\s*=['"]/i.test(
    value,
  );
}

function safeResourceValues(value: string, property: string, context: ResourceContext): boolean {
  for (let i = 0; i < value.length;) {
    const ch = value[i];
    if (value.startsWith("/*", i)) {
      const end = value.indexOf("*/", i + 2);
      if (end < 0) return false;
      i = end + 2;
      continue;
    }
    if (ch === "\\") return false;
    if (ch === "'" || ch === '"') {
      const quote = ch;
      const start = i;
      i++;
      while (i < value.length && value[i] !== quote) {
        if (value[i] === "\\") i++;
        i++;
      }
      if (i >= value.length) return false;
      // The existing global namespace pass also sees URL-looking string
      // data. Do not newly lower such an image before that pass is token-aware.
      if (namespaceSensitiveData(value.slice(start, i))) context.unrewritableString = true;
      i++;
      continue;
    }
    const ident = /^[a-z_-][a-z0-9_-]*/i.exec(value.slice(i));
    if (ident == null) {
      i++;
      continue;
    }
    i += ident[0].length;
    if (value[i] !== "(") continue;
    const name = ident[0].toLowerCase();
    if (name === "image-set" || name === "-webkit-image-set" || name === "src" || name === "image") return false;
    if (name !== "url") {
      i++;
      continue;
    }
    const arg = parenthesized(value, i);
    if (arg == null) return false;
    let url = arg.content.replace(/^[ \t\r\n\f]+|[ \t\r\n\f]+$/g, "");
    if ((url.startsWith('"') && url.endsWith('"')) || (url.startsWith("'") && url.endsWith("'")))
      url = url.slice(1, -1);
    if (url.startsWith("#")) {
      if (!SVG_RESOURCE_PROPERTIES.has(property.toLowerCase()) || !context.inventory?.ids.has(url.slice(1)))
        return false;
      context.hasLocalReference = true;
      i = arg.end;
      continue;
    }
    if (!/^data:/i.test(url) || /[\s<>\x22\x27()\\&]/.test(url)) return false;
    i = arg.end;
  }
  return true;
}

/** A newly admitted imported reference must not expose an ordinary neighboring
 * source reference to host lookup. This is admission only, not the shared
 * ordinary-image rewrite repair tracked by DM-WT73T4. */
function safeOriginalImageReferences(context: ResourceContext): boolean {
  if (context.inventory == null) return false;
  const pending = [context.inventory.root];
  const declarationsSafe = (css: string): boolean => {
    try {
      let safe = true;
      const root = postcss.parse(css);
      if (!selectorsRewritable(root)) return false;
      root.walkDecls((decl) => {
        if (!safeResourceValues(decl.value, decl.prop, context)) safe = false;
      });
      return safe;
    } catch {
      return false;
    }
  };
  while (pending.length > 0) {
    const element = pending.pop()!;
    for (const attribute of element.sourceAttributes ?? []) {
      const value = element.attributes.get(attribute.name);
      if (attribute.name === "href" || attribute.name === "xlink:href") {
        if (value == null) return false;
        if (value.startsWith("#")) {
          if (!context.inventory.ids.has(value.slice(1))) return false;
          if (
            attribute.syntax !== `${attribute.name}="${value}"` &&
            attribute.syntax !== `${attribute.name}='${value}'`
          )
            return false;
        } else if (!/^data:/i.test(value) || /[\s<>\x22\x27()\\&]/.test(value)) return false;
      } else if (
        attribute.name === "style" ||
        SVG_RESOURCE_PROPERTIES.has(attribute.name) ||
        ["cursor", "background-image", "offset-path"].includes(attribute.name)
      ) {
        if (value == null || (attribute.value.includes("&") && /url\s*\(/i.test(value))) return false;
        if (attribute.name === "style") {
          if (!declarationsSafe(`e{${value}}`)) return false;
        } else if (!safeResourceValues(value, attribute.name, context)) return false;
      } else if (attribute.name === "begin" || attribute.name === "end" || namespaceSensitiveData(attribute.value))
        return false;
    }
    if (element.name === "style" || element.name.endsWith(":style")) {
      if (element.texts.some((text) => text == null) || !declarationsSafe(element.texts.join(""))) return false;
    } else if (element.texts.some((text) => text == null || namespaceSensitiveData(text))) return false;
    pending.push(...element.children);
  }
  return !context.unrewritableString;
}

function serializableCss(css: string): boolean {
  return !/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/i.test(css);
}

function parenthesized(text: string, start: number): { content: string; end: number } | null {
  if (text[start] !== "(") return null;
  let depth = 0;
  for (let index = start; index < text.length; index++) {
    if (text[index] === "(") depth++;
    else if (text[index] === ")" && --depth === 0) {
      return { content: text.slice(start + 1, index), end: index + 1 };
    }
  }
  return null;
}

interface ImportSpec {
  url: string;
  layer: string | null;
  supports: string | null;
  media: string | null;
}

function importSpec(params: string): ImportSpec | null {
  const match = /^\s*(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]*))\s*\)|"([^"]*)"|'([^']*)')([\s\S]*)$/i.exec(params);
  if (match == null) return null;
  let rest = match[6].trim();
  let layer: string | null = null;
  if (/^layer(?:\s|\(|$)/i.test(rest)) {
    rest = rest.slice(5).trimStart();
    if (rest.startsWith("(")) {
      const arg = parenthesized(rest, 0);
      if (arg == null) return null;
      layer = arg.content.trim();
      rest = rest.slice(arg.end).trimStart();
    } else {
      layer = "";
    }
  }
  let supports: string | null = null;
  if (/^supports\(/i.test(rest)) {
    const arg = parenthesized(rest, 8);
    if (arg == null) return null;
    supports = arg.content.trim();
    rest = rest.slice(arg.end).trimStart();
  }
  return { url: match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5], layer, supports, media: rest || null };
}

function expandCss(css: string, depth: number, encoding: string, resources: ResourceContext): string | null {
  if (depth > MAX_IMPORT_DEPTH || Buffer.byteLength(css, "utf8") > MAX_CSS_BYTES || !serializableCss(css)) return null;
  if (hasEscapedImport(css)) return null;
  let root: Root;
  try {
    root = postcss.parse(css);
  } catch {
    return null;
  }
  if (!selectorsRewritable(root)) resources.unrewritableString = true;
  // A data-imported sheet can contain another resource URL. In SVG image mode
  // that resource may be blocked, whereas the inlined host document could load
  // it. Keep the original image raster when that distinction matters.
  let hasResourceValue = false;
  root.walkDecls((declaration) => {
    if (!safeResourceValues(declaration.value, declaration.prop, resources)) hasResourceValue = true;
  });
  if (hasResourceValue) return null;
  let importsAllowed = true;
  for (const node of [...root.nodes]) {
    if (node.type !== "atrule" || node.name.toLowerCase() !== "import") {
      if (
        node.type !== "comment" &&
        !(node.type === "atrule" && node.name.toLowerCase() === "charset") &&
        !(node.type === "atrule" && node.name.toLowerCase() === "layer" && node.nodes == null)
      )
        importsAllowed = false;
      continue;
    }
    const spec = importSpec(node.params);
    if (!importsAllowed) {
      node.remove(); // Blink ignores an @import after a style rule.
      continue;
    }
    if (spec == null) return null;
    // CSS escapes or XML entities may change the URL scheme after parsing.
    // Keep the original image when we cannot classify its resource safely.
    if (/[\\&]/.test(spec.url)) return null;
    let absolute: URL | undefined;
    try {
      absolute = new URL(spec.url);
    } catch {
      /* Relative URLs cannot load in image mode. */
    }
    const decoded = absolute?.protocol === "data:" ? dataCss(absolute.href, encoding) : { text: "", encoding };
    if (decoded == null) return null;
    const nested = expandCss(decoded.text, depth + 1, decoded.encoding, resources);
    if (nested == null) return null;
    let inserted = nested;
    if (spec.layer != null) inserted = `@layer ${spec.layer} { ${inserted} }`;
    if (spec.supports != null) {
      const condition = /^(?:\(|not\b|selector\()/i.test(spec.supports) ? spec.supports : `(${spec.supports})`;
      inserted = `@supports ${condition} { ${inserted} }`;
    }
    if (spec.media != null) inserted = `@media ${spec.media} { ${inserted} }`;
    let replacement: Root;
    try {
      replacement = postcss.parse(inserted);
    } catch {
      return null;
    }
    (node as AtRule).replaceWith(...replacement.nodes);
  }
  const expanded = root.toString();
  return Buffer.byteLength(expanded, "utf8") <= MAX_CSS_BYTES ? expanded : null;
}

/** Author font metrics are not available to the isolated system-font resolver.
 * Ignore strings and URL payloads, whose bytes are not CSS dimensions. */
function usesFontMetricUnit(value: string): boolean {
  let dimensions = "";
  for (let i = 0; i < value.length; i++) {
    if (value.startsWith("/*", i)) {
      const end = value.indexOf("*/", i + 2);
      if (end < 0) return true;
      i = end + 1;
      continue;
    }
    const ch = value[i];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      for (i++; i < value.length && value[i] !== quote; i++) if (value[i] === "\\") i++;
      continue;
    }
    if (ch === "\\") {
      dimensions += ch + (value[++i] ?? "");
      continue;
    }
    const url = /^url\s*\(/i.exec(value.slice(i));
    if (url != null) {
      const end = parenthesized(value, i + url[0].length - 1);
      if (end == null) return true;
      i = end.end - 1;
      continue;
    }
    dimensions += ch;
  }
  return /(?:\d*\.?\d+(?:e[+-]?\d+)?)\s*(?:r?ex|r?cap|r?ch|r?ic|r?lh)\b/i.test(cssUnescape(dimensions));
}

function unresolvedAuthorFontMetrics(svg: string): boolean {
  let authorFonts = false,
    metricUnits = false;
  for (const sheet of imageStyleSheets(svg, true) ?? []) {
    const text = xmlStyleText(sheet.css);
    if (text == null) return true;
    try {
      const root = postcss.parse(text);
      let escapedRule = false;
      root.walkAtRules((rule) => {
        if (rule.name.includes("\\")) escapedRule = true;
        if (rule.name.toLowerCase() === "font-face") authorFonts = true;
      });
      if (escapedRule) return true;
      root.walkDecls((decl) => {
        if (usesFontMetricUnit(decl.value)) metricUnits = true;
      });
    } catch {
      return true;
    }
  }
  if (!authorFonts) return false;
  const root = parseImageElementTree(svg);
  if (root == null) return true;
  for (const name of ["style", "transform", "transform-origin", "font-size", "translate", "rotate", "scale"]) {
    const value = root.attributes.get(name);
    if (value === null) return true;
    if (value != null && usesFontMetricUnit(value)) metricUnits = true;
  }
  return metricUnits;
}

function hasEscapedImport(css: string): boolean {
  const names = css.matchAll(/@((?:[a-z0-9_-]|\\(?:[0-9a-f]{1,6}(?:\r\n|[ \t\n\r\f])?|[^\r\n\f]))+)/gi);
  for (const match of names) {
    if (match[1].includes("\\") && cssUnescape(match[1]).toLowerCase() === "import") return true;
  }
  return false;
}

/** Resolve image-allowed data CSS imports and remove blocked external imports. */
export function resolveSvgImageCssImports(svgText: string, ownFontContext = false): string | null {
  const sheets = imageStyleSheets(svgText);
  if (sheets == null) return null;
  const unknownXmlEncoding = /<\?xml[^>]*encoding\s*=\s*['"](?!utf-8['"])[^'"]+['"]/i.test(svgText);
  if (unknownXmlEncoding && sheets.length > 0) return null;
  let unresolved = false;
  let resources: ResourceContext | undefined;
  const out = replaceImageStyleSheets(svgText, ({ open, css, close }) => {
    if (!/[@&<]/.test(css)) return open + css + close;
    if (Buffer.byteLength(css, "utf8") > MAX_CSS_BYTES) {
      unresolved = true;
      return open + css + close;
    }
    const text = xmlStyleText(css);
    if (text != null && !/@import\b/i.test(text) && !hasEscapedImport(text))
      return open + (text === css ? css : serializeImageStyleText(text)) + close;
    resources ??= { inventory: imageFragmentInventory(svgText), hasLocalReference: false, unrewritableString: false };
    const expanded = text == null || unknownXmlEncoding ? null : expandCss(text, 0, "utf-8", resources);
    if (expanded == null) {
      unresolved = true;
      return open + css + close;
    }
    const serialized = serializeImageStyleText(expanded, css.includes("<![CDATA["));
    if (Buffer.byteLength(serialized, "utf8") > MAX_CSS_BYTES) {
      unresolved = true;
      return open + css + close;
    }
    return open + serialized + close;
  });
  return unresolved ||
    (resources?.hasLocalReference && !safeOriginalImageReferences(resources)) ||
    (!ownFontContext && unresolvedAuthorFontMetrics(out))
    ? null
    : out;
}
