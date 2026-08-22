/**
 * Blink-native form-control ownership, transcribed from LayoutTheme.
 *
 * The browser keeps the specified/computed `appearance` separate from
 * ComputedStyle::EffectiveAppearance().  The latter also depends on cascade
 * *origin* flags (`HasAuthorBackground` / `HasAuthorBorder`), which are not
 * exposed by getComputedStyle().  The CDP pre-pass supplies those flags; this
 * browser-safe module applies the same final switch as pinned Chromium.
 *
 * Source: Chromium 7d859f271cbda744098ac69f44978d4edfa62be3
 * - layout_theme.cc: AutoAppearanceFor, AdjustAppearanceWithAuthorStyle,
 *   IsControlStyled
 * - style_cascade.cc / cascade_resolver.h: author flags are collected only
 *   after CSS-wide revert values have resolved to their winning origin.
 */

export interface ControlDescriptor {
  tag: string;
  type?: string;
  multiple?: boolean;
  selectSize?: number;
  selectHasSizeAttribute?: boolean;
}

export interface AuthorControlStyleFacts {
  available: boolean;
  hasAuthorBackground: boolean;
  hasAuthorBorder: boolean;
  reason?: string;
}

export interface CdpCssPropertyLike {
  name: string;
  value: string;
  important?: boolean;
  parsedOk?: boolean;
  disabled?: boolean;
  longhandProperties?: CdpCssPropertyLike[];
}

export interface CdpCssStyleLike {
  cssProperties?: CdpCssPropertyLike[];
}

export interface CdpRuleLike {
  origin?: string;
  style?: CdpCssStyleLike;
  layers?: Array<Record<string, unknown>>;
}

export interface CdpMatchedStylesLike {
  matchedCSSRules?: Array<{ rule?: CdpRuleLike }>;
  attributesStyle?: CdpCssStyleLike;
  inlineStyle?: CdpCssStyleLike;
  animationStyles?: Array<{ style?: CdpCssStyleLike }>;
  transitionsStyle?: CdpCssStyleLike;
}

export interface CascadeDirection {
  direction?: string;
  writingMode?: string;
}

const BACKGROUND_LONGHANDS = [
  "background-attachment",
  "background-clip",
  "background-color",
  "background-image",
  "background-origin",
  "background-position-x",
  "background-position-y",
  "background-repeat",
  "background-size",
] as const;

const PHYSICAL_BORDER_LONGHANDS = [
  "border-top-color", "border-right-color", "border-bottom-color", "border-left-color",
  "border-top-style", "border-right-style", "border-bottom-style", "border-left-style",
  "border-top-width", "border-right-width", "border-bottom-width", "border-left-width",
  "border-top-left-radius", "border-top-right-radius",
  "border-bottom-right-radius", "border-bottom-left-radius",
  "border-image-source", "border-image-slice", "border-image-width",
  "border-image-outset", "border-image-repeat",
] as const;

const BACKGROUND_SET = new Set<string>(BACKGROUND_LONGHANDS);
const BORDER_SET = new Set<string>(PHYSICAL_BORDER_LONGHANDS);

type CascadeOrigin = "ua" | "user" | "author" | "animation" | "transition";

interface Candidate {
  property: string;
  value: string;
  important: boolean;
  origin: CascadeOrigin;
  layer: string | null;
  layerIndex: number;
  order: number;
  ruleKey: string;
}

function normalizedAppearance(value: string | undefined): string {
  const appearance = (value ?? "auto").trim().toLowerCase();
  return appearance === "" ? "auto" : appearance;
}

/** Blink InputTypeView::AutoAppearance and LayoutTheme::AutoAppearanceFor. */
export function autoAppearanceForControl(control: ControlDescriptor): string {
  const tag = control.tag.toLowerCase();
  if (tag === "button") return "button";
  if (tag === "progress") return "progress-bar";
  if (tag === "meter") return "meter";
  if (tag === "textarea") return "textarea";
  if (tag === "select") {
    const size = Number.isFinite(control.selectSize) ? Math.max(0, control.selectSize ?? 0) : 0;
    const usesMenuList = control.multiple
      ? Boolean(control.selectHasSizeAttribute) && size === 1
      : size <= 1;
    return usesMenuList ? "menulist" : "listbox";
  }
  if (tag !== "input") return "none";

  switch ((control.type ?? "text").toLowerCase()) {
    case "button":
    case "reset":
    case "submit":
      return "push-button";
    case "color":
      return "square-button";
    case "checkbox":
      return "checkbox";
    case "radio":
      return "radio";
    case "range":
      return "slider-horizontal";
    case "search":
      return "searchfield";
    case "file":
    case "hidden":
    case "image":
      return "none";
    default:
      // TextFieldInputType owns text/password/email/url/tel/number. Pinned
      // Chromium's enabled multiple-fields temporal view uses the same
      // TextField appearance for date/time/month/week/datetime-local.
      return "textfield";
  }
}

export function appearanceNeedsAuthorStyleFacts(appearance: string): boolean {
  return new Set([
    "button", "push-button", "square-button", "progress-bar", "meter",
    "menulist", "searchfield", "textarea", "textfield",
  ]).has(appearance);
}

/** Mirror LayoutTheme::AdjustAppearanceWithElementType before author style. */
function elementTypeAdjustedAppearance(specified: string, control: ControlDescriptor): string {
  const auto = autoAppearanceForControl(control);
  if (specified === auto) return specified;
  switch (specified) {
    case "none":
    case "base":
    case "base-select":
      // Unsupported base values are already rejected/adjusted by Blink before
      // they reach the computed-style surface read by capture.
      return specified;
    case "auto":
    case "checkbox":
    case "radio":
    case "push-button":
    case "square-button":
    case "inner-spin-button":
    case "listbox":
    case "menulist":
    case "meter":
    case "progress-bar":
    case "slider-horizontal":
    case "slider-thumb-horizontal":
    case "searchfield":
    case "searchfield-cancel-button":
    case "textarea":
      return auto;
    case "button":
      return auto === "push-button" || auto === "square-button" ? specified : auto;
    case "menulist-button":
      return auto === "menulist" ? specified : auto;
    case "slider-vertical":
      return auto === "slider-horizontal" ? specified : auto;
    case "slider-thumb-vertical":
      return auto === "slider-thumb-horizontal" ? specified : auto;
    case "textfield":
      return control.tag.toLowerCase() === "input"
          && (control.type ?? "text").toLowerCase() === "search"
        ? specified
        : auto;
    default:
      return specified;
  }
}

/** Mirror LayoutTheme::AdjustAppearanceWithAuthorStyle. */
export function effectiveAppearanceForControl(
  specifiedAppearance: string | undefined,
  control: ControlDescriptor,
  facts: AuthorControlStyleFacts | undefined,
  hasResolvedBoxShadow: boolean,
): string | null {
  const specified = normalizedAppearance(specifiedAppearance);
  const appearance = elementTypeAdjustedAppearance(specified, control);

  // These states are explicitly CSS-owned. `base` is included even though
  // older protocol schemas only enumerate base-select: current Blink exposes
  // it through its base-appearance feature and stores the fact separately.
  if (appearance === "none" || appearance === "base" || appearance === "base-select") {
    return appearance;
  }
  if (!appearanceNeedsAuthorStyleFacts(appearance)) return appearance;
  if (facts == null || !facts.available) return null;

  const authorBox = facts.hasAuthorBackground || facts.hasAuthorBorder;
  switch (appearance) {
    case "button":
    case "push-button":
    case "square-button":
    case "progress-bar":
    case "meter":
      return authorBox ? "none" : appearance;
    case "menulist":
      return authorBox || hasResolvedBoxShadow ? "menulist-button" : appearance;
    case "searchfield":
    case "textarea":
    case "textfield":
      return authorBox || hasResolvedBoxShadow ? "none" : appearance;
    default:
      return appearance;
  }
}

/** Appearances for which ThemePainter owns the complete host surface. */
export function isWholeHostNativeAppearance(appearance: string): boolean {
  return new Set([
    "button", "push-button", "square-button", "progress-bar", "meter",
    "menulist", "searchfield", "textarea", "textfield",
    "checkbox", "radio", "slider-horizontal", "slider-vertical",
  ]).has(appearance);
}

function originForProtocol(value: string | undefined): CascadeOrigin {
  if (value === "user-agent") return "ua";
  // Document-owned injected sheets represent the user/injected origin in the
  // protocol. Regular page sheets and the inspector author sheet are author.
  if (value === "injected") return "user";
  return "author";
}

function layerIdentity(layers: Array<Record<string, unknown>> | undefined): string | null {
  if (layers == null || layers.length === 0) return null;
  // Protocol order is inner-most to outer-most. Named layers with the same
  // path intentionally coalesce across sheets; anonymous layers instead need
  // source coordinates to remain distinct.
  return [...layers].reverse().map((layer) => {
    const range = layer.range as { startLine?: number; startColumn?: number } | undefined;
    const name = String(layer.text ?? "").trim();
    if (name !== "") return `named:${name}`;
    return [
      "anonymous",
      String(layer.styleSheetId ?? ""),
      String(range?.startLine ?? ""),
      String(range?.startColumn ?? ""),
    ].join(":");
  }).join("/");
}

type PhysicalSide = "top" | "right" | "bottom" | "left";

function logicalSides(direction: CascadeDirection): {
  inlineStart: PhysicalSide;
  inlineEnd: PhysicalSide;
  blockStart: PhysicalSide;
  blockEnd: PhysicalSide;
} {
  const rtl = direction.direction?.toLowerCase() === "rtl";
  switch (direction.writingMode?.toLowerCase()) {
    case "vertical-rl":
    case "sideways-rl":
      return {
        inlineStart: rtl ? "bottom" : "top",
        inlineEnd: rtl ? "top" : "bottom",
        blockStart: "right",
        blockEnd: "left",
      };
    case "vertical-lr":
      return {
        inlineStart: rtl ? "bottom" : "top",
        inlineEnd: rtl ? "top" : "bottom",
        blockStart: "left",
        blockEnd: "right",
      };
    case "sideways-lr":
      return {
        inlineStart: rtl ? "top" : "bottom",
        inlineEnd: rtl ? "bottom" : "top",
        blockStart: "left",
        blockEnd: "right",
      };
    default:
      return {
        inlineStart: rtl ? "right" : "left",
        inlineEnd: rtl ? "left" : "right",
        blockStart: "top",
        blockEnd: "bottom",
      };
  }
}

function canonicalLonghand(name: string, direction: CascadeDirection): string {
  const lower = name.toLowerCase();
  const sides = logicalSides(direction);
  const logicalSide = /^border-(block|inline)-(start|end)-(color|style|width)$/.exec(lower);
  if (logicalSide != null) {
    const axis = logicalSide[1];
    const edge = logicalSide[2];
    const suffix = logicalSide[3];
    const key = `${axis}${edge[0].toUpperCase()}${edge.slice(1)}` as
      "blockStart" | "blockEnd" | "inlineStart" | "inlineEnd";
    return `border-${sides[key]}-${suffix}`;
  }

  const logicalCorner = /^border-(start|end)-(start|end)-radius$/.exec(lower);
  if (logicalCorner != null) {
    const block = sides[`${"block"}${logicalCorner[1][0].toUpperCase()}${logicalCorner[1].slice(1)}` as "blockStart" | "blockEnd"];
    const inline = sides[`${"inline"}${logicalCorner[2][0].toUpperCase()}${logicalCorner[2].slice(1)}` as "inlineStart" | "inlineEnd"];
    const vertical = block === "top" || block === "bottom" ? block : inline;
    const horizontal = block === "left" || block === "right" ? block : inline;
    return `border-${vertical}-${horizontal}-radius`;
  }
  return lower;
}

function shorthandNames(name: string): readonly string[] {
  if (name === "all") return [...BACKGROUND_LONGHANDS, ...PHYSICAL_BORDER_LONGHANDS];
  if (name === "background") return BACKGROUND_LONGHANDS;
  if (name === "background-position") return ["background-position-x", "background-position-y"];
  if (name === "border") return PHYSICAL_BORDER_LONGHANDS;
  if (name === "border-color") return ["border-top-color", "border-right-color", "border-bottom-color", "border-left-color"];
  if (name === "border-style") return ["border-top-style", "border-right-style", "border-bottom-style", "border-left-style"];
  if (name === "border-width") return ["border-top-width", "border-right-width", "border-bottom-width", "border-left-width"];
  if (name === "border-radius") return ["border-top-left-radius", "border-top-right-radius", "border-bottom-right-radius", "border-bottom-left-radius"];
  if (name === "border-image") return ["border-image-source", "border-image-slice", "border-image-width", "border-image-outset", "border-image-repeat"];
  const physicalSide = /^border-(top|right|bottom|left)$/.exec(name);
  if (physicalSide != null) {
    return ["color", "style", "width"].map((suffix) => `border-${physicalSide[1]}-${suffix}`);
  }
  const logicalAxis = /^border-(block|inline)(?:-(start|end))?$/.exec(name);
  if (logicalAxis != null) {
    const edges = logicalAxis[2] == null ? ["start", "end"] : [logicalAxis[2]];
    return edges.flatMap((edge) => ["color", "style", "width"].map(
      (suffix) => `border-${logicalAxis[1]}-${edge}-${suffix}`,
    ));
  }
  const logicalQuad = /^border-(block|inline)-(color|style|width)$/.exec(name);
  if (logicalQuad != null) {
    return ["start", "end"].map((edge) => `border-${logicalQuad[1]}-${edge}-${logicalQuad[2]}`);
  }
  return [];
}

function expandedDeclarations(
  style: CdpCssStyleLike | undefined,
  direction: CascadeDirection,
): Map<string, { value: string; important: boolean }> {
  const declarations = new Map<string, { value: string; important: boolean }>();
  for (const declaration of style?.cssProperties ?? []) {
    if (declaration.disabled || declaration.parsedOk === false) continue;
    const rawName = declaration.name.trim().toLowerCase();
    if (rawName === "") continue;
    const expanded = declaration.longhandProperties?.length
      ? declaration.longhandProperties
      : shorthandNames(rawName).map((name) => ({ name, value: declaration.value, important: declaration.important }));
    const values = expanded.length > 0 ? expanded : [declaration];
    for (const value of values) {
      const property = canonicalLonghand(value.name.trim(), direction);
      if (!BACKGROUND_SET.has(property) && !BORDER_SET.has(property)) continue;
      const important = value.important === true || declaration.important === true || /!important\s*$/i.test(value.value);
      declarations.set(property, {
        value: value.value.replace(/\s*!important\s*$/i, "").trim().toLowerCase(),
        important,
      });
    }
  }
  return declarations;
}

function majorCascadeRank(candidate: Candidate): number {
  if (candidate.origin === "transition") return 7;
  if (candidate.origin === "animation") return 3;
  if (!candidate.important) {
    return candidate.origin === "ua" ? 0 : candidate.origin === "user" ? 1 : 2;
  }
  return candidate.origin === "author" ? 4 : candidate.origin === "user" ? 5 : 6;
}

function candidateComparison(layerCount: number): (left: Candidate, right: Candidate) => number {
  return (left, right) => {
    const major = majorCascadeRank(left) - majorCascadeRank(right);
    if (major !== 0) return major;
    const layerRank = (candidate: Candidate): number => {
      if (candidate.layer == null) return candidate.important ? -1 : layerCount + 1;
      return candidate.important ? layerCount - candidate.layerIndex : candidate.layerIndex;
    };
    const layer = layerRank(left) - layerRank(right);
    return layer !== 0 ? layer : left.order - right.order;
  };
}

function winningCandidate(input: readonly Candidate[], layerCount: number): Candidate | undefined {
  let candidates = [...input];
  const compare = candidateComparison(layerCount);
  while (candidates.length > 0) {
    candidates.sort(compare);
    const winner = candidates[candidates.length - 1];
    if (winner.value === "revert") {
      candidates = candidates.filter((candidate) => candidate.origin !== winner.origin);
      continue;
    }
    if (winner.value === "revert-layer") {
      candidates = candidates.filter((candidate) => !(
        candidate.origin === winner.origin
        && candidate.important === winner.important
        && candidate.layer === winner.layer
      ));
      continue;
    }
    if (winner.value === "revert-rule") {
      candidates = candidates.filter((candidate) => candidate.ruleKey !== winner.ruleKey);
      continue;
    }
    return winner;
  }
  return undefined;
}

/**
 * Recover Blink's author-origin property flags from the authoritative rule
 * matches returned by CSS.getMatchedStylesForNode.
 *
 * CDP has already evaluated selectors, media/container/supports conditions,
 * scopes, tree scopes, specificity and source order. We preserve that order,
 * add the property-dependent important/layer inversion, and resolve the three
 * CSS rollback keywords before asking which origin won each flagged longhand.
 */
export function authorControlStyleFactsFromMatchedStyles(
  matched: CdpMatchedStylesLike,
  direction: CascadeDirection = {},
): AuthorControlStyleFacts {
  if (!Array.isArray(matched.matchedCSSRules)) {
    return {
      available: false,
      hasAuthorBackground: false,
      hasAuthorBorder: false,
      reason: "Chromium did not expose matched CSS rules",
    };
  }

  const layerIndexes = new Map<string, number>();
  for (const match of matched.matchedCSSRules) {
    if (match.rule == null || match.rule.style == null || !Array.isArray(match.rule.style.cssProperties)) {
      return {
        available: false,
        hasAuthorBackground: false,
        hasAuthorBorder: false,
        reason: "Chromium returned a partial matched-rule payload",
      };
    }
    const layer = layerIdentity(match.rule.layers);
    if (layer != null && !layerIndexes.has(layer)) layerIndexes.set(layer, layerIndexes.size);
  }

  const byProperty = new Map<string, Candidate[]>();
  let order = 0;
  const addStyle = (
    style: CdpCssStyleLike | undefined,
    origin: CascadeOrigin,
    layer: string | null,
    ruleKey: string,
  ): string | null => {
    for (const [property, declaration] of expandedDeclarations(style, direction)) {
      if (/\b(?:var|env)\(/i.test(declaration.value)) {
        return `${property} contains a substitution whose rollback origin is not exposed by CDP`;
      }
      const candidates = byProperty.get(property) ?? [];
      candidates.push({
        property,
        value: declaration.value,
        important: declaration.important,
        origin,
        layer,
        layerIndex: layer == null ? -1 : (layerIndexes.get(layer) ?? -1),
        order: order++,
        ruleKey,
      });
      byProperty.set(property, candidates);
    }
    return null;
  };

  // Presentation attributes are author-origin but precede stylesheet rules.
  let unavailable = addStyle(matched.attributesStyle, "author", null, "attributes");
  for (let index = 0; unavailable == null && index < matched.matchedCSSRules.length; index++) {
    const rule = matched.matchedCSSRules[index].rule!;
    const layer = layerIdentity(rule.layers);
    unavailable = addStyle(rule.style, originForProtocol(rule.origin), layer, `rule:${index}`);
  }
  if (unavailable == null) unavailable = addStyle(matched.inlineStyle, "author", null, "inline");
  for (let index = 0; unavailable == null && index < (matched.animationStyles?.length ?? 0); index++) {
    unavailable = addStyle(matched.animationStyles![index].style, "animation", null, `animation:${index}`);
  }
  if (unavailable == null) {
    unavailable = addStyle(matched.transitionsStyle, "transition", null, "transition");
  }
  if (unavailable != null) {
    return {
      available: false,
      hasAuthorBackground: false,
      hasAuthorBorder: false,
      reason: unavailable,
    };
  }

  let hasAuthorBackground = false;
  let hasAuthorBorder = false;
  for (const [property, candidates] of byProperty) {
    const winner = winningCandidate(candidates, layerIndexes.size);
    if (winner?.origin !== "author") continue;
    if (BACKGROUND_SET.has(property)) hasAuthorBackground = true;
    if (BORDER_SET.has(property)) hasAuthorBorder = true;
  }
  return { available: true, hasAuthorBackground, hasAuthorBorder };
}
