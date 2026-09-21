// @ts-nocheck
//
// Pure value-level decisions for inline SVG capture. The live handler retains
// DOM cloning, CTM probes, warning emission, and fallback ownership.

const UNRESOLVED_CSS_EXPRESSION = /\b(?:var|calc|env|attr)\s*\(/;

export const isUnresolvedSvgCssExpression = (value) => (
  value != null && UNRESOLVED_CSS_EXPRESSION.test(value)
);

export const isConcreteSvgAttributeValue = (value) => (
  value != null && !isUnresolvedSvgCssExpression(value)
);

export const isActiveSvgTransformValue = (value) => (
  value != null && String(value).trim() !== '' && String(value).trim() !== 'none'
);

export const isSvgTransformAnimation = (localName, attributeName) => {
  const name = String(localName || '').toLowerCase();
  const attribute = String(attributeName || '').toLowerCase();
  return name === 'animatemotion' || name === 'animatetransform'
    || (name === 'animate' || name === 'set') && attribute === 'transform';
};

export const normalizeComputedSvgGeometry = (attribute, computedValue) => {
  let value = computedValue == null ? '' : String(computedValue).trim();
  if (value === '' || value === 'auto' || value === 'none' || value === 'normal') return null;
  if (attribute === 'd') {
    const match = /^path\(\s*(?:"([^"]*)"|'([^']*)')\s*\)$/.exec(value);
    return match == null ? null : (match[1] != null ? match[1] : match[2]);
  }
  if (/^-?\d+(?:\.\d+)?px$/.test(value)) value = value.slice(0, -2);
  return value;
};

export const shouldBakeSvgGeometry = (sourceValue, normalizedValue, smilOwnsValue) => {
  if (smilOwnsValue || normalizedValue == null) return false;
  return sourceValue == null
    || isUnresolvedSvgCssExpression(sourceValue)
    || String(sourceValue).trim() !== normalizedValue;
};

export const composeUseTransform = (transform, x, y) => {
  const translate = (x !== 0 || y !== 0) ? ('translate(' + x + ',' + y + ')') : '';
  return (String(transform || '') + ' ' + translate).trim();
};

export const shouldStripPromotedViewportDimension = (sourceValue, clonedValue) => (
  !isConcreteSvgAttributeValue(sourceValue) && /^0(?:\.0+)?$/.test(String(clonedValue || ''))
);
