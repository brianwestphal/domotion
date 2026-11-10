import { xmlStyleText } from "./svg-image-css-import.js";
import { cssUnescape, parseImageElementTree, type ImageElement } from "./svg-image-selector-engine.js";
import {
  IMAGE_SVG_RESOURCE_PROPERTIES,
  rewriteImageCssValue,
  rewriteImageInlineStyle,
  rewriteImageLocalUrl,
  rewriteImageStyleSheet,
  type ImageReferenceContext,
} from "./svg-image-reference-css.js";
import { referenceXmlAttributeValue } from "./svg-image-reference-syntax.js";

const IDREFS = new Set([
  "aria-labelledby",
  "aria-describedby",
  "aria-controls",
  "aria-owns",
  "aria-flowto",
  "aria-activedescendant",
  "aria-details",
  "aria-errormessage",
  "for",
]);
const MUTATED_ATTRIBUTES = [
  "id",
  "class",
  "style",
  "href",
  "xlink:href",
  "begin",
  "end",
  ...IDREFS,
  ...IMAGE_SVG_RESOURCE_PROPERTIES,
];
const OTHER_URI_ATTRIBUTES = new Set([
  "cursor",
  "color-profile",
  "background",
  "background-image",
  "backdrop-filter",
  "offset-path",
  "shape-inside",
  "shape-outside",
  "-webkit-mask",
]);

interface Edit {
  start: number;
  end: number;
  value: string;
}

/** SVG image documents have their own tree scope. Unlike shared DOM-inline
 * prefixSvgIds, this pass authenticates DOM identities and every supported
 * reference before moving them into the output document. Unknown ownership
 * keeps the original source image, including its own fallback paint. */
export function namespaceImageReferences(svg: string, prefix: string): string | null {
  if (prefix === "" || /<!DOCTYPE\b|<\?xml-stylesheet\b/i.test(svg)) return null;
  const root = parseImageElementTree(svg, true);
  if (root == null || root.name !== "svg") return null;
  const elements: ImageElement[] = [],
    pending = [root],
    ids = new Set<string>();
  while (pending.length > 0) {
    const element = pending.pop()!;
    const attributes = element.sourceAttributes;
    if (
      attributes == null ||
      element.sourceRange == null ||
      new Set(attributes.map((a) => a.name)).size !== attributes.length
    )
      return null;
    if (
      [...element.attributes.values()].some((v) => v == null) ||
      attributes.some((a) => a.value.includes("<") || /&(?!(?:lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);)/i.test(a.value))
    )
      return null;
    // Namespace prefixes/default namespaces can change which attributes are
    // SVG references; do not infer their meaning from their local spelling.
    if (element.name.includes(":") || element.attributes.has("xml:base")) return null;
    const namespace = element.attributes.get("xmlns");
    if (namespace !== undefined && namespace !== "http://www.w3.org/2000/svg") return null;
    const xlink = element.attributes.get("xmlns:xlink");
    if (xlink !== undefined && xlink !== "http://www.w3.org/1999/xlink") return null;
    const id = element.attributes.get("id");
    if (id !== undefined) {
      if (id == null || id === "" || ids.has(id) || /[\u0000\ud800-\udfff]/u.test(id)) return null;
      ids.add(id);
    }
    if (/^(?:animate|set|animateTransform|animateMotion)$/.test(element.name)) {
      const attribute = element.attributes.get("attributeName");
      if (attribute != null && MUTATED_ATTRIBUTES.includes(attribute)) return null;
    }
    elements.push(element);
    pending.push(...element.children);
  }
  // The names are private only if neither authored XML nor decoded CSS can
  // address them. Preserve original DOM values for attribute tests/attr().
  const vocabulary = cssUnescape(
    svg + elements.flatMap((e) => [...e.attributes.values(), ...e.texts]).join(" "),
  ).toLowerCase();
  let serial = 0,
    privatePrefix: string;
  do {
    privatePrefix = `data-domotion-source-${serial++}-`;
  } while (vocabulary.includes(privatePrefix));
  const originals = new Map(MUTATED_ATTRIBUTES.map((name, index) => [name, privatePrefix + index]));
  const context: ImageReferenceContext = { prefix, ids, originals };
  const hasStyle = elements.some((e) => e.name === "style");
  const edits: Edit[] = [];
  for (const element of elements) {
    let saved = "";
    for (const source of element.sourceAttributes!) {
      const name = source.name,
        value = element.attributes.get(name)!;
      if (value == null) return null;
      const privateName = originals.get(name);
      if (privateName != null) saved += ` ${privateName}="${referenceXmlAttributeValue(value)}"`;
      let rewritten: string | null = value;
      if (name === "id") rewritten = prefix + value;
      else if (name === "class" && hasStyle) rewritten = value.replace(/[^ \t\n\r\f]+/g, (token) => prefix + token);
      else if (name === "style") rewritten = rewriteImageInlineStyle(value, context);
      else if (name === "href" || name === "xlink:href")
        rewritten = value.startsWith("#") ? rewriteImageLocalUrl(value, context) : /^data:/i.test(value) ? value : null;
      else if (IMAGE_SVG_RESOURCE_PROPERTIES.has(name)) rewritten = rewriteImageCssValue(value, name, context);
      else if (OTHER_URI_ATTRIBUTES.has(name)) rewritten = rewriteImageCssValue(value, name, context);
      else if (IDREFS.has(name)) {
        let safe = true;
        rewritten = value.replace(/[^ \t\n\r\f]+/g, (id) => {
          if (!ids.has(id)) safe = false;
          return prefix + id;
        });
        if (!safe) rewritten = null;
      } else if (name === "begin" || name === "end") rewritten = rewriteTiming(value, context);
      if (rewritten == null) return null;
      if (rewritten !== value)
        edits.push({
          start: source.start,
          end: source.end,
          value: `${name}="${referenceXmlAttributeValue(rewritten)}"`,
        });
    }
    const range = element.sourceRange!;
    if (saved !== "")
      edits.push({
        start: range.openEnd - (range.selfClosing ? 2 : 1),
        end: range.openEnd - (range.selfClosing ? 2 : 1),
        value: saved,
      });
    if (element.name === "style" && !range.selfClosing) {
      const css = xmlStyleText(svg.slice(range.openEnd, range.closeStart));
      if (css == null || element.children.length !== 0) return null;
      const rewritten = rewriteImageStyleSheet(css, context);
      // The XML-aware stylesheet consumers preserve literal end-tag data in CDATA.
      if (rewritten == null) return null;
      edits.push({
        start: range.openEnd,
        end: range.closeStart,
        value: /[<&]|\]\]>/.test(rewritten)
          ? `<![CDATA[${rewritten.replace(/\]\]>/g, "]]]]><![CDATA[>")}]]>`
          : rewritten,
      });
    }
  }
  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  let result = svg,
    boundary = svg.length;
  for (const edit of edits) {
    if (edit.end > boundary) return null;
    result = result.slice(0, edit.start) + edit.value + result.slice(edit.end);
    boundary = edit.start;
  }
  return result;
}

/** SVGSMILElement::ParseCondition uses the first unescaped dot as the
 * syncbase/eventbase separator. Clock values are parsed first. Escaped dots
 * belong to the actual ID, not to the event name (Chromium7d859f27). */
function rewriteTiming(value: string, context: ImageReferenceContext): string | null {
  let safe = true;
  const out = value
    .split(";")
    .map((item) => {
      const clock = item.trim();
      if (/^(?:indefinite|[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:h|min|ms|s)?|(?:\d+:)?\d{2}:\d{2}(?:\.\d+)?)$/.test(clock))
        return item;
      let dot = -1;
      for (let at = 0; at < clock.length; at++) {
        if (clock[at] === "\\") at++;
        else if (clock[at] === ".") {
          dot = at;
          break;
        }
      }
      if (dot < 0) {
        if (!/^(?:[a-zA-Z_][\w-]*|accessKey\([^)]*\)|wallclock\([^)]*\))(?:\s*[+-].*)?$/.test(clock)) safe = false;
        return item;
      }
      const id = clock.slice(0, dot).replace(/\\(.)/gs, "$1");
      // ParseCondition searches '+'/'-' before interpreting the base ID.
      // A prefix that introduces either would turn a valid condition into
      // an offset parse. Keep that source animation instead.
      if (!context.ids.has(id) || /[+-]/.test(context.prefix + id)) {
        safe = false;
        return item;
      }
      return (context.prefix + id).replace(/[.\\]/g, "\\$&") + clock.slice(dot);
    })
    .join(";");
  return safe ? out : null;
}
