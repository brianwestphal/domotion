import { parseCssFontFamilyEntries } from "../../font-family-stack.js";
import { fuseFontFeatureValueRules, IMPLICIT_OUTER_LAYER_ORDER } from "../../font-feature-values-cascade.js";
import type { FontFeatureValueCategory, FontFeatureValueTable } from "../../font-feature-values-cascade.js";

interface LayerNode {
  children: LayerNode[];
  named: Map<string, LayerNode>;
  order: number;
}
type FeatureValuesRule = CSSRule & {
  fontFamily: string;
  stylistic: Map<string, number[]>;
} & Record<FontFeatureValueCategory, Map<string, number[]>>;
type ExtendedRule = CSSRule &
  Partial<{
    nameList: string[];
    name: string;
    cssRules: CSSRuleList;
    media: MediaList;
    supportsText: string;
    layerName: string;
    styleSheet: CSSStyleSheet;
    conditionText: string;
    fontFamily: string;
    stylistic: Map<string, number[]>;
  }>;

/**
 * Collect Blink's effective document-owned `@font-feature-values` storage.
 *
 * Chromium 7d859f27 builds one canonical cascade-layer tree for every active
 * document stylesheet, numbers it in postorder, and fuses each alias key with
 * the higher layer order (`style_rule_font_feature_values.cc:83-122`,
 * `cascade_layer_map.cc:40-80`). The implicit outer layer is UINT16_MAX.
 * `ScopedStyleResolver::AddFontFeatureValuesRules` explicitly ignores shadow
 * TreeScopes, while `CSSFontSelector::GetFontData` consults only the document
 * resolver (`scoped_style_resolver.cc:355-386`, `css_font_selector.cc:192-220`).
 */
export function collectFontFeatureValues(doc: Document) {
  const categories: FontFeatureValueCategory[] = [
    "annotation",
    "ornaments",
    "stylistic",
    "swash",
    "characterVariant",
    "styleset",
  ];
  // Retain this shared-parser call at the collection boundary. Besides keeping
  // the capture bundle dependency live, it makes malformed/empty family lists
  // disappear exactly where the pure fusion helper will discard them.
  const hasFamily = (css: string) => parseCssFontFamilyEntries(css).length > 0;
  const makeLayer = (): LayerNode => ({ children: [], named: new Map<string, LayerNode>(), order: -1 });
  const rootLayer = makeLayer();
  const pending: Array<{ fontFamily: string; layer: LayerNode; table: FontFeatureValueTable }> = [];
  const view = doc.defaultView || window;

  const decodeIdent = (value: string): string => {
    let output = "";
    for (let index = 0; index < value.length;) {
      if (value[index] !== "\\") {
        output += value[index++];
        continue;
      }
      index++;
      let hex = "";
      while (index < value.length && hex.length < 6 && /[0-9a-f]/i.test(value[index])) {
        hex += value[index++];
      }
      if (hex !== "") {
        const codePoint = Number.parseInt(hex, 16);
        output +=
          codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)
            ? "\ufffd"
            : String.fromCodePoint(codePoint);
        if (index < value.length && /[\t\n\f\r ]/.test(value[index])) index++;
      } else if (index < value.length) {
        output += value[index++];
      }
    }
    return output;
  };
  const splitLayerName = (value: string): string[] => {
    const parts: string[] = [];
    let part = "";
    for (let index = 0; index < value.length; index++) {
      const char = value[index];
      if (char === "\\") {
        part += char;
        if (index + 1 < value.length) part += value[++index];
      } else if (char === ".") {
        parts.push(decodeIdent(part));
        part = "";
      } else {
        part += char;
      }
    }
    if (part !== "") parts.push(decodeIdent(part));
    return parts;
  };
  const addLayer = (parent: LayerNode, serializedName: string): LayerNode => {
    if (serializedName === "") {
      const anonymous = makeLayer();
      parent.children.push(anonymous);
      return anonymous;
    }
    let layer = parent;
    for (const name of splitLayerName(serializedName)) {
      let child = layer.named.get(name);
      if (child == null) {
        child = makeLayer();
        layer.named.set(name, child);
        layer.children.push(child);
      }
      layer = child;
    }
    return layer;
  };
  const mediaMatches = (media: string | null | undefined): boolean =>
    media == null || media === "" || view.matchMedia(media).matches;
  const supportsMatches = (condition: string | null | undefined): boolean =>
    condition == null || condition === "" || (view.CSS != null && view.CSS.supports(condition));

  const readFeatureRule = (rule: FeatureValuesRule, layer: LayerNode): void => {
    if (typeof rule.fontFamily !== "string" || rule.stylistic == null || !hasFamily(rule.fontFamily)) return;
    const table: FontFeatureValueTable = {};
    for (const category of categories) {
      const entries = Array.from(rule[category].entries());
      if (entries.length === 0) continue;
      const aliases: Record<string, number[]> = {};
      for (const [name, values] of entries) aliases[name] = Array.from(values);
      table[category] = aliases;
    }
    pending.push({ fontFamily: rule.fontFamily, layer, table });
  };

  const visitRules = (rules: CSSRuleList | null | undefined, parentLayer: LayerNode): void => {
    if (rules == null) return;
    for (const cssRule of Array.from(rules)) {
      const rule = cssRule as ExtendedRule;
      const kind = rule.constructor.name;
      if (kind === "CSSLayerStatementRule") {
        for (const name of Array.from(rule.nameList || [])) addLayer(parentLayer, name);
        continue;
      }
      if (kind === "CSSLayerBlockRule") {
        visitRules(rule.cssRules, addLayer(parentLayer, rule.name || ""));
        continue;
      }
      if (kind === "CSSImportRule") {
        if (!mediaMatches(rule.media?.mediaText) || !supportsMatches(rule.supportsText)) continue;
        const importLayer = rule.layerName == null ? parentLayer : addLayer(parentLayer, rule.layerName || "");
        try {
          visitRules(rule.styleSheet?.cssRules, importLayer);
        } catch {
          /* cross-origin import */
        }
        continue;
      }
      if (kind === "CSSMediaRule" && !mediaMatches(rule.media?.mediaText || rule.conditionText)) continue;
      if (kind === "CSSSupportsRule" && !supportsMatches(rule.conditionText)) continue;
      if (typeof rule.fontFamily === "string" && rule.stylistic != null) {
        readFeatureRule(rule as FeatureValuesRule, parentLayer);
      } else if (rule.cssRules != null) {
        // Blink threads @scope and @container ownership into style rules, but
        // FontFeatureValuesStorage itself is still document-global.
        visitRules(rule.cssRules, parentLayer);
      }
    }
  };

  const sheets = [...Array.from(doc.styleSheets), ...Array.from(doc.adoptedStyleSheets || [])];
  for (const sheet of sheets) {
    if (sheet.disabled || !mediaMatches(sheet.media?.mediaText)) continue;
    try {
      visitRules(sheet.cssRules, rootLayer);
    } catch {
      /* cross-origin sheet */
    }
  }

  let nextOrder = 0;
  const assignPostorder = (layer: LayerNode): void => {
    for (const child of layer.children) assignPostorder(child);
    if (layer !== rootLayer) layer.order = nextOrder++;
  };
  assignPostorder(rootLayer);

  return fuseFontFeatureValueRules(
    pending.map(({ fontFamily, layer, table }) => ({
      fontFamily,
      layerOrder: layer === rootLayer ? IMPLICIT_OUTER_LAYER_ORDER : layer.order,
      table,
    })),
  );
}
