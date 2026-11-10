/** Name identity at the XML image → HTML foreign-content boundary (DM-SC5Y23).
 * HTMLTokenizer folds ASCII case; HTMLTreeBuilder then restores mixed-case SVG
 * names from GetTags/GetAttrs, plus its manual names. XML keeps authored case.
 * Pinned Chromium7d859f271cbda744098ac69f44978d4edfa62be3:
 * core/html/parser/{html_tokenizer,html_tree_builder}.cc,
 * core/svg/{svg_tag_names,svg_attribute_names}.json5.
 * Compare only: never normalize an inert source name into an active one.
 */
import { asciiLower, parseImageElementTree, parseSelectorList } from "./svg-image-selector-engine.js";
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
 * canonical selector grammar, including nested functional selector lists.
 * Unsupported selectors retain source ownership instead of guessing names. */
export function imageHtmlSelectorNamesUnchanged(selector: string): boolean {
  const parsed = parseSelectorList(selector);
  if (parsed == null) return false;
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
