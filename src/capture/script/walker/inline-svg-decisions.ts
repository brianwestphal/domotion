//
// Pure value-level decisions for inline SVG capture. The live handler retains
// DOM cloning, CTM probes, warning emission, and fallback ownership.

const UNRESOLVED_CSS_EXPRESSION = /\b(?:var|calc|env|attr)\s*\(/;

export const isUnresolvedSvgCssExpression = (value: string | null | undefined): boolean =>
  value != null && UNRESOLVED_CSS_EXPRESSION.test(value);

export const isConcreteSvgAttributeValue = (value: string | null | undefined): boolean =>
  value != null && !isUnresolvedSvgCssExpression(value);

export const isActiveSvgTransformValue = (value: string | null | undefined): boolean =>
  value != null && String(value).trim() !== "" && String(value).trim() !== "none";

export const isSvgTransformAnimation = (
  localName: string | null | undefined,
  attributeName: string | null | undefined,
): boolean => {
  const name = String(localName || "").toLowerCase();
  const attribute = String(attributeName || "").toLowerCase();
  return (
    name === "animatemotion" ||
    name === "animatetransform" ||
    ((name === "animate" || name === "set") && attribute === "transform")
  );
};

export const normalizeComputedSvgGeometry = (
  attribute: string,
  computedValue: string | null | undefined,
): string | null => {
  let value = computedValue == null ? "" : String(computedValue).trim();
  if (value === "" || value === "auto" || value === "none" || value === "normal") return null;
  if (attribute === "d") {
    const match = /^path\(\s*(?:"([^"]*)"|'([^']*)')\s*\)$/.exec(value);
    return match == null ? null : match[1] != null ? match[1] : match[2];
  }
  if (/^-?\d+(?:\.\d+)?px$/.test(value)) value = value.slice(0, -2);
  return value;
};

export const shouldBakeSvgGeometry = (
  sourceValue: string | null | undefined,
  normalizedValue: string | null,
  smilOwnsValue: boolean,
): boolean => {
  if (smilOwnsValue || normalizedValue == null) return false;
  return (
    sourceValue == null || isUnresolvedSvgCssExpression(sourceValue) || String(sourceValue).trim() !== normalizedValue
  );
};

export const composeUseTransform = (transform: string | null | undefined, x: number, y: number): string => {
  const translate = x !== 0 || y !== 0 ? "translate(" + x + "," + y + ")" : "";
  return (String(transform || "") + " " + translate).trim();
};

/** Constrain one sprite selector to its copied subtree without changing SVG-root matching. */
export const scopeExternalSvgSelector = (selector: string, scopeId: string): string => {
  const trimmed = selector.trim();
  return /^svg(?=\s|\.|#|\[|:|$)/i.test(trimmed)
    ? trimmed.replace(/^svg/i, `svg #${scopeId}`)
    : `#${scopeId} ${trimmed}`;
};

export const scopeExternalSvgSelectorList = (selectors: string, scopeId: string): string => {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = "";
  for (let i = 0; i < selectors.length; i++) {
    const char = selectors[i];
    if (quote) {
      if (char === quote && selectors[i - 1] !== "\\") quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "(" || char === "[") depth++;
    else if (char === ")" || char === "]") depth--;
    else if (char === "," && depth === 0) {
      parts.push(scopeExternalSvgSelector(selectors.slice(start, i), scopeId));
      start = i + 1;
    }
  }
  parts.push(scopeExternalSvgSelector(selectors.slice(start), scopeId));
  return parts.join(", ");
};

export const shouldStripPromotedViewportDimension = (
  sourceValue: string | null | undefined,
  clonedValue: string | null | undefined,
): boolean => !isConcreteSvgAttributeValue(sourceValue) && /^0(?:\.0+)?$/.test(String(clonedValue || ""));
