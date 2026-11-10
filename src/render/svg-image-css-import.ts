import postcss, { type AtRule, type Root } from "postcss";
import {
  imageStyleSheets,
  replaceImageStyleSheets,
  serializeImageStyleText,
  xmlStyleText,
} from "./svg-image-stylesheets.js";
import { cssUnescape, parseImageElementTree } from "./svg-image-selector-engine.js";
import { imageFragmentInventory, type ImageFragmentInventory } from "./svg-image-fragment-ids.js";
import {
  cssImportBlock,
  cssImportTriviaEnd,
  cssImportUrl,
  imageImportKeywords,
  rewriteImportedCssUrls,
} from "./svg-image-css-import-tokens.js";
import { referenceCssIdentifier } from "./svg-image-reference-syntax.js";

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
  requiresSourceProof: boolean;
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
    const arg = cssImportBlock(value, i);
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
      const keywords = imageImportKeywords(css);
      if (keywords == null || keywords.unsupported) return false;
      const root = postcss.parse(keywords.text);
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

interface ImportSpec {
  url: string;
  layer: string | null;
  supports: string | null;
  media: string | null;
}

function importSpec(params: string): ImportSpec | null {
  const start = cssImportTriviaEnd(params, 0);
  if (start == null) return null;
  const token = cssImportUrl(params, start);
  if (token == null) return null;
  let at = cssImportTriviaEnd(params, token.end);
  if (at == null) return null;
  let layer: string | null = null;
  const first = referenceCssIdentifier(params, at);
  if (first?.value.toLowerCase() === "layer") {
    at = first.end;
    if (params[at] === "(") {
      const block = cssImportBlock(params, at);
      if (block == null || block.content.trim() === "") return null;
      layer = block.content.trim();
      at = block.end;
    } else layer = "";
    at = cssImportTriviaEnd(params, at);
    if (at == null) return null;
  }
  let supports: string | null = null;
  const condition = referenceCssIdentifier(params, at);
  if (condition?.value.toLowerCase() === "supports" && params[condition.end] === "(") {
    const block = cssImportBlock(params, condition.end);
    if (block == null) return null;
    supports = block.content.trim();
    at = block.end;
    at = cssImportTriviaEnd(params, at);
    if (at == null) return null;
  }
  return { url: token.value, layer, supports, media: params.slice(at).trim() || null };
}

/** Newly admitted escaped spellings cannot expose neighboring source content
 * to a legacy namespace pass. Keep active/foreign contexts and ambiguous source
 * spelling conservative; this is source admission, never a network probe. */
function escapedSourceSafe(context: ResourceContext): boolean {
  if (!safeOriginalImageReferences(context) || context.inventory == null) return false;
  const pending = [context.inventory.root];
  while (pending.length > 0) {
    const element = pending.pop()!;
    if (
      element.name.includes(":") ||
      /^(?:script|foreignObject|template|iframe|object|embed|audio|video|animate|set|animateTransform|animateMotion)$/i.test(
        element.name,
      )
    )
      return false;
    if (
      /^style$/i.test(element.name) &&
      (element.name !== "style" ||
        element.children.length > 0 ||
        ["media", "title", "disabled"].some((name) => element.attributes.has(name)) ||
        (element.attributes.has("type") && element.attributes.get("type")?.trim().toLowerCase() !== "text/css"))
    )
      return false;
    for (const [name, value] of element.attributes) {
      const folded = name.toLowerCase();
      // XML attribute names are case-sensitive; HTML's SVG parser folds these
      // aliases before attaching resource/style semantics (DM-SC5Y23). Do not
      // newly activate an inert source reference through escaped admission.
      if (
        name !== folded &&
        (SVG_RESOURCE_PROPERTIES.has(folded) ||
          /^(?:href|xlink:href|style|src|cursor|background-image|offset-path|font-family|id|class|xml:base|xmlns(?::.*)?)$/.test(
            folded,
          ))
      )
        return false;
      if (/^on/i.test(name) || name === "xml:base") return false;
      if (name === "xmlns" && value !== "http://www.w3.org/2000/svg") return false;
      if (name === "xmlns:xlink" && value !== "http://www.w3.org/1999/xlink") return false;
    }
    pending.push(...element.children);
  }
  return true;
}
function importedResourceValue(value: string, property: string, context: ResourceContext): string | null {
  return rewriteImportedCssUrls(
    value,
    (url, raw) => {
      if (raw.includes("\\")) context.requiresSourceProof = true;
      if (url.startsWith("#")) {
        if (!SVG_RESOURCE_PROPERTIES.has(property.toLowerCase()) || !context.inventory?.ids.has(url.slice(1)))
          return null;
        context.hasLocalReference = true;
        return url;
      }
      let absolute: URL;
      try {
        absolute = new URL(url);
      } catch {
        return null;
      }
      if (absolute.protocol !== "data:" || /[\s<>\x22\x27()\\&]/.test(absolute.href)) return null;
      return absolute.href;
    },
    (decoded) => {
      if (namespaceSensitiveData(decoded)) context.unrewritableString = true;
    },
  );
}

function expandCss(css: string, depth: number, encoding: string, resources: ResourceContext): string | null {
  if (depth > MAX_IMPORT_DEPTH || Buffer.byteLength(css, "utf8") > MAX_CSS_BYTES || !serializableCss(css)) return null;
  const keywords = imageImportKeywords(css);
  if (keywords == null || keywords.unsupported) return null;
  // Escaped mentions in comments/strings were formerly refused too. Require
  // source proof for that newly admitted surface, while actual import
  // classification comes exclusively from stylesheet tokens.
  resources.requiresSourceProof ||= keywords.changed || legacyEscapedImportSurface(css);
  let root: Root;
  try {
    root = postcss.parse(keywords.text);
  } catch {
    return null;
  }
  if (!selectorsRewritable(root)) resources.unrewritableString = true;
  // A data-imported sheet can contain another resource URL. In SVG image mode
  // that resource may be blocked, whereas the inlined host document could load
  // it. Keep the original image raster when that distinction matters.
  let hasResourceValue = false;
  root.walkDecls((declaration) => {
    const rewritten = importedResourceValue(declaration.value, declaration.prop, resources);
    if (rewritten == null) hasResourceValue = true;
    else declaration.value = rewritten;
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
    resources.requiresSourceProof ||= node.params.includes("\\");
    const spec = importSpec(node.params);
    if (!importsAllowed) {
      node.remove(); // Blink ignores an @import after a style rule.
      continue;
    }
    if (spec == null) return null;
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
      const end = cssImportBlock(value, i + url[0].length - 1);
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

/** Compatibility proof escalation, deliberately including inert mentions that
 * the former detector refused. This never decides whether an import is active. */
function legacyEscapedImportSurface(css: string): boolean {
  for (let at = css.indexOf("@"); at >= 0; at = css.indexOf("@", at + 1)) {
    const ident = referenceCssIdentifier(css, at + 1);
    if (ident?.value.toLowerCase() === "import" && css.slice(at + 1, ident.end).includes("\\")) return true;
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
    if (text == null) {
      unresolved = true;
      return open + css + close;
    }
    const keywords = imageImportKeywords(text);
    if (keywords == null) {
      unresolved = true;
      return open + css + close;
    }
    if (!keywords.hasImport && !legacyEscapedImportSurface(text))
      return open + (text === css ? css : serializeImageStyleText(text)) + close;
    resources ??= {
      inventory: imageFragmentInventory(svgText),
      hasLocalReference: false,
      unrewritableString: false,
      requiresSourceProof: false,
    };
    const expanded = expandCss(text, 0, "utf-8", resources);
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
    (resources?.requiresSourceProof && !escapedSourceSafe(resources)) ||
    (!ownFontContext && unresolvedAuthorFontMetrics(out))
    ? null
    : out;
}
