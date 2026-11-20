/** Name identity at the XML image → HTML foreign-content boundary (DM-SC5Y23).
 * HTMLTokenizer folds ASCII case; HTMLTreeBuilder then restores mixed-case SVG
 * names from GetTags/GetAttrs, plus its manual names. XML keeps authored case.
 * Pinned Chromium7d859f271cbda744098ac69f44978d4edfa62be3:
 * core/html/parser/{html_tokenizer,html_tree_builder}.cc,
 * core/svg/{svg_tag_names,svg_attribute_names}.json5.
 * Compare only: never normalize an inert source name into an active one.
 */
import { asciiLower, cssUnescape, parseImageElementTree, parseSelectorList } from "./svg-image-selector-engine.js";
const TAG_NAMES = new Map([
  ["animatecolor", "animateColor"],
  ["animatemotion", "animateMotion"],
  ["animatetransform", "animateTransform"],
  ["clippath", "clipPath"],
  ["feblend", "feBlend"],
  ["fecolormatrix", "feColorMatrix"],
  ["fecomponenttransfer", "feComponentTransfer"],
  ["fecomposite", "feComposite"],
  ["feconvolvematrix", "feConvolveMatrix"],
  ["fediffuselighting", "feDiffuseLighting"],
  ["fedisplacementmap", "feDisplacementMap"],
  ["fedistantlight", "feDistantLight"],
  ["fedropshadow", "feDropShadow"],
  ["feflood", "feFlood"],
  ["fefunca", "feFuncA"],
  ["fefuncb", "feFuncB"],
  ["fefuncg", "feFuncG"],
  ["fefuncr", "feFuncR"],
  ["fegaussianblur", "feGaussianBlur"],
  ["feimage", "feImage"],
  ["femerge", "feMerge"],
  ["femergenode", "feMergeNode"],
  ["femorphology", "feMorphology"],
  ["feoffset", "feOffset"],
  ["fepointlight", "fePointLight"],
  ["fespecularlighting", "feSpecularLighting"],
  ["fespotlight", "feSpotLight"],
  ["fetile", "feTile"],
  ["feturbulence", "feTurbulence"],
  ["foreignobject", "foreignObject"],
  ["lineargradient", "linearGradient"],
  ["radialgradient", "radialGradient"],
  ["textpath", "textPath"],
  ["altglyph", "altGlyph"],
  ["altglyphdef", "altGlyphDef"],
  ["altglyphitem", "altGlyphItem"],
  ["glyphref", "glyphRef"],
]);
const ATTRIBUTE_NAMES = new Map([
  ["attributename", "attributeName"],
  ["attributetype", "attributeType"],
  ["basefrequency", "baseFrequency"],
  ["baseprofile", "baseProfile"],
  ["calcmode", "calcMode"],
  ["clippathunits", "clipPathUnits"],
  ["diffuseconstant", "diffuseConstant"],
  ["edgemode", "edgeMode"],
  ["filterunits", "filterUnits"],
  ["glyphref", "glyphRef"],
  ["gradienttransform", "gradientTransform"],
  ["gradientunits", "gradientUnits"],
  ["kernelmatrix", "kernelMatrix"],
  ["kernelunitlength", "kernelUnitLength"],
  ["keypoints", "keyPoints"],
  ["keysplines", "keySplines"],
  ["keytimes", "keyTimes"],
  ["lengthadjust", "lengthAdjust"],
  ["limitingconeangle", "limitingConeAngle"],
  ["markerheight", "markerHeight"],
  ["markerunits", "markerUnits"],
  ["markerwidth", "markerWidth"],
  ["maskcontentunits", "maskContentUnits"],
  ["maskunits", "maskUnits"],
  ["numoctaves", "numOctaves"],
  ["pathlength", "pathLength"],
  ["patterncontentunits", "patternContentUnits"],
  ["patterntransform", "patternTransform"],
  ["patternunits", "patternUnits"],
  ["pointsatx", "pointsAtX"],
  ["pointsaty", "pointsAtY"],
  ["pointsatz", "pointsAtZ"],
  ["preservealpha", "preserveAlpha"],
  ["preserveaspectratio", "preserveAspectRatio"],
  ["primitiveunits", "primitiveUnits"],
  ["refx", "refX"],
  ["refy", "refY"],
  ["repeatcount", "repeatCount"],
  ["repeatdur", "repeatDur"],
  ["requiredextensions", "requiredExtensions"],
  ["requiredfeatures", "requiredFeatures"],
  ["specularconstant", "specularConstant"],
  ["specularexponent", "specularExponent"],
  ["spreadmethod", "spreadMethod"],
  ["startoffset", "startOffset"],
  ["stddeviation", "stdDeviation"],
  ["stitchtiles", "stitchTiles"],
  ["surfacescale", "surfaceScale"],
  ["systemlanguage", "systemLanguage"],
  ["tablevalues", "tableValues"],
  ["targetx", "targetX"],
  ["targety", "targetY"],
  ["textlength", "textLength"],
  ["viewbox", "viewBox"],
  ["xchannelselector", "xChannelSelector"],
  ["ychannelselector", "yChannelSelector"],
  ["zoomandpan", "zoomAndPan"],
  ["viewtarget", "viewTarget"],
]);

export function imageHtmlNameUnchanged(name: string, attribute: boolean): boolean {
  const folded = asciiLower(name);
  return ((attribute ? ATTRIBUTE_NAMES : TAG_NAMES).get(folded) ?? folded) === name;
}

/** Check the original source before imports/font/style rewrites can obscure a
 * spelling, then check rewritten trees again at the reference boundary. */
export function imageHtmlSourceNamesUnchanged(source: string): boolean {
  const root = parseImageElementTree(source, true);
  if (root == null) return false;
  const pending = [root];
  while (pending.length > 0) {
    const element = pending.pop()!;
    if (
      !imageHtmlNameUnchanged(element.name, false) ||
      element.sourceAttributes?.some((attribute) => !imageHtmlNameUnchanged(attribute.name, true))
    )
      return false;
    pending.push(...element.children);
  }
  return true;
}

/** HTML CSS selector parsing also folds type/attribute names. Reuse the
 * canonical selector grammar, including nested functional selector lists;
 * selectors outside it take the conservative lexical name pass below, and
 * anything that pass does not recognize retains source ownership. */
export function imageHtmlSelectorNamesUnchanged(selector: string): boolean {
  const parsed = parseSelectorList(selector);
  if (parsed == null) return lexicalSelectorNamesUnchanged(selector, 0, selector.length, 0);
  const pending = [...parsed];
  while (pending.length > 0) {
    for (const compound of pending.pop()!.compounds)
      for (const simple of compound) {
        if (simple.k === "type" && simple.name !== "*" && !imageHtmlNameUnchanged(simple.name, false)) return false;
        if (simple.k === "attr" && !imageHtmlNameUnchanged(simple.name, true)) return false;
        if (simple.k === "logical" || simple.k === "has") pending.push(...simple.list);
        if (simple.k === "nth" && simple.of != null) pending.push(...simple.of);
      }
  }
  return true;
}

// Functional pseudos whose argument is itself a selector (list). Pinned
// Chromium 7d859f27 css_selector_parser.cc: :is/:where/:not/:has (forgiving /
// relative lists), :host/:host-context/:-webkit-any/::cue (compound lists,
// :1696-1727), ::slotted (one compound) and :nth-*child `of S`.
const SELECTOR_ARGUMENT_PSEUDOS = new Set([
  "is",
  "where",
  "not",
  "has",
  "matches",
  "any",
  "-webkit-any",
  "host",
  "host-context",
  "cue",
  "slotted",
]);
// Functional pseudos whose arguments are idents, strings or An+B only, never
// element or attribute names (css_selector_parser.cc :dir/:state, ::part,
// :active-view-transition-type, ::view-transition-*, :lang; ::highlight takes
// a custom ident).
const NAME_FREE_ARGUMENT_PSEUDOS = new Set([
  "lang",
  "dir",
  "state",
  "part",
  "highlight",
  "active-view-transition-type",
  "view-transition-group",
  "view-transition-group-children",
  "view-transition-image-pair",
  "view-transition-old",
  "view-transition-new",
  "nth-of-type",
  "nth-last-of-type",
]);
const identStart = (char: string | undefined): boolean =>
  char != null && (/[A-Za-z_\-\\]/.test(char) || char.charCodeAt(0) >= 0x80);
const identPart = (char: string | undefined): boolean =>
  char != null && (/[A-Za-z0-9_\-\\]/.test(char) || char.charCodeAt(0) >= 0x80);

/** Consume a CSS identifier (with escapes) starting at `at`; returns its end. */
function identifierEnd(text: string, at: number, end: number): number {
  let index = at;
  while (index < end && identPart(text[index])) {
    if (text[index] === "\\") {
      const escape = /^\\(?:[0-9a-fA-F]{1,6}(?:\r\n|[ \t\n\r\f])?|[^\n\r\f])/.exec(text.slice(index, end));
      if (escape == null) return -1;
      index += escape[0].length;
    } else index++;
  }
  return index;
}
function stringEnd(text: string, at: number, end: number): number {
  const quote = text[at];
  for (let index = at + 1; index < end; index++) {
    if (text[index] === "\\") index++;
    else if (text[index] === quote) return index + 1;
    else if (text[index] === "\n") return -1;
  }
  return -1;
}
function closingParen(text: string, open: number, end: number): number {
  let depth = 0;
  for (let index = open; index < end; index++) {
    const char = text[index];
    if (char === "\\") index++;
    else if (char === '"' || char === "'") {
      const close = stringEnd(text, index, end);
      if (close < 0) return -1;
      index = close - 1;
    } else if (text.startsWith("/*", index)) {
      const close = text.indexOf("*/", index + 2);
      if (close < 0 || close + 2 > end) return -1;
      index = close + 1;
    } else if (char === "(") depth++;
    else if (char === ")" && --depth === 0) return index;
  }
  return -1;
}

/**
 * A lexical pass over selectors the shared grammar does not model (for example
 * `:lang(en) rect`, pseudo-elements or `::slotted()`). It authenticates only the
 * names HTML CSS parsing folds — type selectors (`ConsumeCompoundSelector`,
 * css_selector_parser.cc:1322-1324) and attribute names (`ConsumeAttribute`,
 * :1545-1547) — descending into every selector-bearing functional pseudo. A
 * namespace `|`, an unknown functional pseudo, a stray string or any other
 * unrecognized token refuses, so nothing outside this boundary is guessed.
 */
function lexicalSelectorNamesUnchanged(text: string, start: number, end: number, depth: number): boolean {
  if (depth > 32) return false;
  let compoundStart = true;
  for (let at = start; at < end;) {
    const char = text[at];
    if (text.startsWith("/*", at)) {
      const close = text.indexOf("*/", at + 2);
      if (close < 0 || close + 2 > end) return false;
      at = close + 2;
      continue;
    }
    if (/[ \t\n\r\f>+~,]/.test(char)) {
      compoundStart = true;
      at++;
      continue;
    }
    if (char === "|") return false; // namespace prefix or column combinator
    if (char === "*" || char === "&") {
      if (text[at + 1] === "|") return false;
      compoundStart = false;
      at++;
      continue;
    }
    if (char === "#" || char === ".") {
      // IDs and classes are case-sensitive data in both parsers.
      const close = identifierEnd(text, at + 1, end);
      if (close <= at + 1) return false;
      compoundStart = false;
      at = close;
      continue;
    }
    if (char === "[") {
      let nameStart = at + 1;
      while (/[ \t\n\r\f]/.test(text[nameStart] ?? "")) nameStart++;
      const nameEnd = identifierEnd(text, nameStart, end);
      // `ns|name` refuses; `|=` is the dash-match operator.
      if (nameEnd <= nameStart || (text[nameEnd] === "|" && text[nameEnd + 1] !== "=")) return false;
      if (!imageHtmlNameUnchanged(cssUnescape(text.slice(nameStart, nameEnd)), true)) return false;
      let close = nameEnd;
      while (close < end && text[close] !== "]") {
        if (text[close] === '"' || text[close] === "'") {
          const after = stringEnd(text, close, end);
          if (after < 0) return false;
          close = after;
        } else if (text[close] === "|" && text[close + 1] !== "=") return false;
        else close += text[close] === "\\" ? 2 : 1;
      }
      if (close >= end) return false;
      compoundStart = false;
      at = close + 1;
      continue;
    }
    if (char === ":") {
      const nameStart = text[at + 1] === ":" ? at + 2 : at + 1;
      const nameEnd = identifierEnd(text, nameStart, end);
      if (nameEnd <= nameStart) return false;
      const name = asciiLower(cssUnescape(text.slice(nameStart, nameEnd)));
      compoundStart = false;
      if (text[nameEnd] !== "(") {
        at = nameEnd;
        continue;
      }
      const close = closingParen(text, nameEnd, end);
      if (close < 0) return false;
      if (SELECTOR_ARGUMENT_PSEUDOS.has(name)) {
        if (!lexicalSelectorNamesUnchanged(text, nameEnd + 1, close, depth + 1)) return false;
      } else if (name === "nth-child" || name === "nth-last-child") {
        const of = /\s+of\s+/i.exec(text.slice(nameEnd + 1, close));
        if (of != null && !lexicalSelectorNamesUnchanged(text, nameEnd + 1 + of.index + of[0].length, close, depth + 1))
          return false;
      } else if (!NAME_FREE_ARGUMENT_PSEUDOS.has(name)) return false;
      at = close + 1;
      continue;
    }
    if (identStart(char) && compoundStart) {
      const close = identifierEnd(text, at, end);
      if (close <= at || text[close] === "|") return false;
      if (!imageHtmlNameUnchanged(cssUnescape(text.slice(at, close)), false)) return false;
      compoundStart = false;
      at = close;
      continue;
    }
    return false;
  }
  return true;
}
