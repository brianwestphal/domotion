import { parseCssFontFamilyEntries } from "../font-family-stack.js";
import type { CdpMatchedStylesLike } from "./effective-appearance.js";

export interface MatchedFamilyDeclarations extends CdpMatchedStylesLike {
  inherited?: CdpMatchedStylesLike[];
  pseudoElements?: Array<{ pseudoType: string; matches: NonNullable<CdpMatchedStylesLike["matchedCSSRules"]> }>;
}

/**
 * A declaration fact, not a second CSS cascade. A scope is conclusive only if
 * every family-affecting declaration is a literal concrete family list. Then
 * specificity, importance and layers cannot change its authored family type.
 * CSS-wide values, substitutions and incomplete shorthand evidence stop the
 * search: they may reset or inherit past an otherwise authored ancestor.
 */
export function matchedFamilyIsUnambiguouslyAuthored(matched: MatchedFamilyDeclarations): boolean {
  for (const scope of [matched, ...(matched.inherited ?? [])]) {
    if (!Array.isArray(scope.matchedCSSRules)) return false;
    if (scope.matchedCSSRules.some(({ rule }) => rule?.origin == null || !Array.isArray(rule.style?.cssProperties)))
      return false;
    let authored = false;
    let affectsFamily = false;
    let uncertain = false;
    const styles = [
      { style: scope.attributesStyle, author: true },
      ...(scope.matchedCSSRules ?? []).map(({ rule }) => ({
        style: rule?.style,
        author: rule?.origin !== "user-agent",
      })),
      { style: scope.inlineStyle, author: true },
      ...(scope.animationStyles ?? []).map(({ style }) => ({ style, author: true, animated: true })),
      { style: scope.transitionsStyle, author: true, animated: true },
    ];
    for (const row of styles) {
      const { style, author } = row;
      const properties = style?.cssProperties ?? [];
      // PopulateAllProperties appends canonical CSSStyleDeclaration values
      // without source ranges/text. They normalize escapes and discard losing
      // declarations within one style; source text cannot provide that fact.
      const canonical = properties.filter((property) => !("range" in property) && !("text" in property));
      const familyProperty = (name: string): boolean => {
        const decoded = parseCssFontFamilyEntries(name)[0]?.name.toLowerCase();
        return decoded === "font" || decoded === "font-family" || decoded === "all";
      };
      if (
        properties.some(
          (property) => !property.disabled && property.parsedOk !== false && familyProperty(property.name),
        ) &&
        !canonical.some((property) => familyProperty(property.name))
      ) {
        affectsFamily = true;
        uncertain = true;
      }
      for (const declaration of canonical) {
        if (declaration.disabled || declaration.parsedOk === false) continue;
        const name = parseCssFontFamilyEntries(declaration.name)[0]?.name.toLowerCase();
        if (name !== "font" && name !== "font-family" && name !== "all") continue;
        affectsFamily = true;
        // Interpolated inspector values are computed CSS values; their family
        // serialization can already have lost kStandardFamily provenance.
        if ("animated" in row && row.animated) uncertain = true;
        const rawFamily =
          name === "font"
            ? declaration.longhandProperties?.find((property) => property.name === "font-family")?.value
            : declaration.value;
        // Canonical important entries append this exact priority spelling
        // (InspectorStyle::PopulateAllProperties), outside the CSS value.
        const family = declaration.important ? rawFamily?.replace(/\s*!important\s*$/i, "") : rawFamily;
        const entries = family == null ? [] : parseCssFontFamilyEntries(family);
        if (
          name === "all" ||
          family == null ||
          /^(?:initial|inherit|unset|revert(?:-layer|-rule)?)\s*$/i.test(family) ||
          entries.length === 0 ||
          entries.some(
            (entry) =>
              !entry.quoted &&
              (/^(?:initial|inherit|unset|revert(?:-layer|-rule)?)$/i.test(entry.name) ||
                /\b(?:var|env|attr|if)\s*\(/i.test(entry.name) ||
                parseCssFontFamilyEntries(entry.name.toLowerCase()).some((decoded) => decoded.type !== "family-name")),
          )
        ) {
          uncertain = true;
        } else if (author) authored = true;
      }
    }
    if (affectsFamily) return authored && !uncertain;
  }
  return false;
}

export interface FontFamilyDeclarationFact {
  family: string;
  authored: boolean;
  authoredPseudos: string[];
}
