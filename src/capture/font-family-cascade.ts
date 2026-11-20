import { parseCssFontFamilyEntries } from "../font-family-stack.js";
import type { CdpCssPropertyLike } from "./effective-appearance.js";
import type { FamilyValue } from "./font-family-values.js";

export type ProvenFamilyType = "standard" | "concrete";
export interface FamilyStyle {
  cssProperties?: CdpCssPropertyLike[];
  shorthandEntries?: Array<{ name: string; value: string; important?: boolean }>;
}
export interface FamilyRule {
  origin?: string;
  originTreeScopeNodeId?: number;
  style?: FamilyStyle;
  layers?: Array<{ text?: string }>;
  scopes?: unknown[];
  startingStyles?: unknown[];
  navigations?: unknown[];
}
export interface FamilyScope {
  matchedCSSRules?: Array<{ rule?: FamilyRule }>;
  inlineStyle?: FamilyStyle;
  attributesStyle?: FamilyStyle;
  animationStyles?: Array<{ style?: FamilyStyle }>;
  transitionsStyle?: FamilyStyle;
}
export interface FamilyKeyframeRule {
  keyText?: { text?: string };
  style?: FamilyStyle;
}
export interface FamilyKeyframesRule {
  animationName?: { text?: string };
  keyframes?: FamilyKeyframeRule[];
}
export interface FamilyMatched extends FamilyScope {
  inherited?: FamilyScope[];
  /** Blink-resolved @keyframes rules for the element's animation-name list
   * (`InspectorCSSAgent::AnimationsForNode`). */
  cssKeyframesRules?: FamilyKeyframesRule[];
}
export interface NativeFamilyLayers {
  name: string;
  order: number;
  subLayers?: NativeFamilyLayers[];
}
/**
 * The tree contexts one element's author rules can come from, in Blink's
 * cascade tree order. `StyleResolver::MatchAuthorRules`
 * (core/css/resolver/style_resolver.cc:1039-1047, Chromium 7d859f27) collects
 * `:host` rules from the element's own shadow root, then `::slotted` rules from
 * each assigned slot's tree scope with the deepest slot first (:773-799), then
 * the element's own scope with its style attribute (:892-913), then `::part`
 * and shadow-pseudo rules from the enclosing scopes outward (:915-1037). Every
 * group starts with `BeginAddingAuthorRulesForTreeScope`, which gives it the
 * next `tree_order` (match_result.cc:85-90), and `CascadePriority` compares
 * `tree_order` right below origin and importance, flipped for important
 * declarations (cascade_priority.h `EncodeTreeOrder`): a later scope wins for
 * normal declarations and an earlier one for important declarations.
 */
export interface FamilyTreeContext {
  /** Tree-scope root backend node ids, lowest `tree_order` first. */
  treeScopes: readonly number[];
  /** The element's own tree scope, the one `layers` and inline style belong to. */
  elementScope: number;
  /** `CSS.getLayersForNode` for an element of `elementScope`: that scope's
   * `CascadeLayerMap`, numbered as `ComputeLayerOrder` does
   * (cascade_layer_map.cc:40-47; inspector_css_agent.cc:1261-1325). */
  layers: NativeFamilyLayers;
}
export interface FamilyCascadeContext {
  /** The element's tree scope's layers, used for every scope without a `treeContexts` entry. */
  layers: NativeFamilyLayers;
  /** The single document tree scope assumed for every scope without a `treeContexts` entry. */
  treeScopeId: number;
  /** Per matched scope (the element, then each inherited ancestor in the
   * flat tree), the tree contexts its author rules may come from. */
  treeContexts?: ReadonlyArray<FamilyTreeContext | undefined>;
  resolve(value: string, shorthand: boolean, scope: number): Promise<FamilyValue>;
  /** Native animation authority for a scope whose cascade winner is an
   * animation. `base` means every animation layer currently applies a neutral
   * keyframe, so the static cascade value shows through. Absent: the
   * interpolated value is refused as before. */
  resolveAnimation?(scope: number): Promise<FamilyResolution | { base: true }>;
}
export type FamilyResolution = { type: ProvenFamilyType } | { reason: string };
type Origin = "ua" | "user" | "hint" | "author" | "animation" | "transition";
interface Candidate {
  value: string;
  shorthand: boolean;
  wideOnly?: boolean;
  important: boolean;
  origin: Origin;
  inline: boolean;
  /** Blink's `tree_order` (0 for every non-author origin). */
  tree: number;
  layer: number;
  order: number;
}
const naturalOrigin = (origin: Origin) => ({ ua: 0, user: 1, hint: 2, author: 3, animation: 4, transition: 5 })[origin];
const major = (c: Candidate) =>
  c.origin === "transition"
    ? 8
    : c.origin === "animation"
      ? 4
      : c.important
        ? { author: 5, user: 6, ua: 7, hint: 5 }[c.origin]
        : naturalOrigin(c.origin);
// `CascadePriority::ForLayerComparison` keeps origin, tree order, inline-ness
// and layer order with importance removed (cascade_priority.h).
const layerKey = (c: Candidate) => [naturalOrigin(c.origin), c.tree, Number(c.inline), c.layer];
const compareKeys = (a: number[], b: number[]) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
};
// CascadePriority bit order: origin/importance, then tree order (high bits),
// then inline style, layer order and position (low bits). Tree and layer order
// are flipped for important declarations.
const priority = (c: Candidate) => [
  major(c),
  c.important ? -c.tree : c.tree,
  Number(c.inline),
  c.important ? -c.layer : c.layer,
  c.order,
];
const compare = (a: Candidate, b: Candidate) => compareKeys(priority(a), priority(b));

/** Resolve a rule's enclosing `@layer` names (outermost first, as the
 * inspector lists them) to the native layer order. Nested blocks and dotted
 * names concatenate into one path (`@layer a { @layer b.c }` is `a.b.c`), and
 * the canonical map merges equal named paths, so a named path is unique. An
 * anonymous layer has no name to look up, and a name with an escape cannot be
 * split reliably, so both are refused. */
function layerOrderForRule(layers: NativeFamilyLayers, texts: ReadonlyArray<{ text?: string }>): number | undefined {
  const path: string[] = [];
  for (const { text } of texts) {
    if (text == null || text === "" || text.includes("\\")) return undefined;
    for (const segment of text.split(".")) {
      if (segment === "") return undefined;
      path.push(segment);
    }
  }
  let level: NativeFamilyLayers | undefined = layers;
  for (const segment of path) {
    const matches: NativeFamilyLayers[] = (level?.subLayers ?? []).filter((layer) => layer.name === segment);
    if (matches.length !== 1) return undefined;
    level = matches[0];
  }
  return level !== layers && level != null && Number.isSafeInteger(level.order) ? level.order : undefined;
}
const clean = (value: string) => value.replace(/\/\*[\s\S]*?\*\//g, " ").trim();
export function canonicalFamily(
  style: FamilyStyle | undefined,
): Array<{ value: string; shorthand: boolean; important: boolean; wideOnly?: boolean }> | string {
  if (style == null) return [];
  if (!Array.isArray(style.cssProperties)) return "incomplete canonical font style";
  const all = style.cssProperties;
  const canonical = all.filter((p) => !("range" in p) && !("text" in p) && !p.disabled && p.parsedOk !== false);
  const names = (p: CdpCssPropertyLike) => parseCssFontFamilyEntries(p.name)[0]?.name.toLowerCase();
  if (
    all.some((p) => !p.disabled && p.parsedOk !== false && ["font-family", "font", "all"].includes(names(p) ?? "")) &&
    !canonical.some((p) => ["font-family", "font", "all"].includes(names(p) ?? ""))
  )
    return "missing canonical family longhand";
  const result = [];
  for (const p of canonical) {
    const name = names(p);
    if (name !== "font-family" && name !== "all" && name !== "font") continue;
    const important = p.important === true;
    let value = important ? p.value.replace(/\s*!important\s*$/i, "") : p.value;
    const shorthand = name === "font" || (name === "font-family" && value === "");
    if (name === "font-family" && value === "") {
      const pending = style.shorthandEntries?.filter((s) => s.name === "font");
      if (pending?.length !== 1 || !pending[0].value) return "pending family has no canonical shorthand";
      value = pending[0].value;
    } else if (name === "font") {
      const family = p.longhandProperties?.find((x) => x.name === "font-family");
      if (family != null) value = family.value;
    }
    if (important) value = value.replace(/\s*!important\s*$/i, "");
    if (
      name === "all" &&
      !/^(?:initial|inherit|unset|revert(?:-layer)?)$/i.test(clean(value)) &&
      !/var\s*\(/i.test(value)
    )
      return "unproved all substitution";
    result.push({
      value,
      wideOnly: name === "all",
      shorthand: shorthand && !(name === "font" && p.longhandProperties?.some((x) => x.name === "font-family")),
      important,
    });
  }
  return result;
}

/** Transcribe only the canonical matched family cascade. No font name, width
 * or painted-face observation is used to choose the resulting family type.
 * CSSCascadePriority::ForLayerComparison drops importance before rollback. */
export async function resolveMatchedFontFamilyType(
  matched: FamilyMatched,
  context: FamilyCascadeContext,
): Promise<FamilyResolution> {
  if (!Number.isSafeInteger(context.treeScopeId)) return { reason: "unavailable tree-scope identity" };
  const scopes = [matched, ...(matched.inherited ?? [])];
  if (scopes.length > 64) return { reason: "font inheritance depth exceeds budget" };
  for (let index = 0; index < scopes.length; index++) {
    const scope = scopes[index];
    if (!Array.isArray(scope.matchedCSSRules)) return { reason: "incomplete matched font rules" };
    const tree: FamilyTreeContext = context.treeContexts?.[index] ?? {
      treeScopes: [context.treeScopeId],
      elementScope: context.treeScopeId,
      layers: context.layers,
    };
    if (!Number.isSafeInteger(tree.layers.order)) return { reason: "unavailable native layer order" };
    const elementTree = tree.treeScopes.indexOf(tree.elementScope);
    if (elementTree < 0 || new Set(tree.treeScopes).size !== tree.treeScopes.length)
      return { reason: "unavailable tree-scope identity" };
    const candidates: Candidate[] = [];
    let order = 0;
    let lastAuthorTree = -1;
    const add = (
      style: FamilyStyle | undefined,
      origin: Origin,
      inline = false,
      layer = tree.layers.order,
      treeOrder = 0,
    ): string | undefined => {
      const entries = canonicalFamily(style);
      if (typeof entries === "string") return entries;
      for (const entry of entries)
        candidates.push({ ...entry, origin, inline, tree: treeOrder, layer, order: order++ });
    };
    let reason = add(scope.attributesStyle, "hint");
    for (const { rule } of scope.matchedCSSRules) {
      if (reason) break;
      if (rule == null || rule.style == null || rule.origin == null) {
        reason = "incomplete matched font rule";
        break;
      }
      const familyEntries = canonicalFamily(rule.style);
      if (typeof familyEntries === "string") {
        reason = familyEntries;
        break;
      }
      if (familyEntries.length === 0) continue;
      if (rule.scopes?.length || rule.startingStyles?.length || rule.navigations?.length) {
        reason = "unproved scoped or starting font cascade";
        break;
      }
      const origin: Origin | undefined =
        rule.origin === "user-agent" ? "ua" : ["regular", "inspector"].includes(rule.origin) ? "author" : undefined;
      if (origin == null) {
        reason = "unsupported stylesheet origin";
        break;
      }
      let treeOrder = 0;
      if (origin !== "ua") {
        treeOrder = rule.originTreeScopeNodeId == null ? -1 : tree.treeScopes.indexOf(rule.originTreeScopeNodeId);
        if (treeOrder < 0) {
          reason = "unproved font tree-scope order";
          break;
        }
        // The inspector lists rules in collection order
        // (`PseudoCSSRulesForElement` runs `MatchAuthorRules`, and
        // `SortAndTransferMatchedRules` appends each tree-scope group in
        // turn; element_rule_collector.cc:1235-1255). A list that steps back
        // to an earlier tree context contradicts the derived order.
        if (treeOrder < lastAuthorTree) {
          reason = "matched font rule order contradicts tree order";
          break;
        }
        lastAuthorTree = treeOrder;
      }
      let layer = tree.layers.order;
      if (rule.layers?.length) {
        // `layers` is the CascadeLayerMap of the element's own tree scope only.
        const resolved = treeOrder === elementTree ? layerOrderForRule(tree.layers, rule.layers) : undefined;
        if (resolved == null) {
          reason = "unproved font layer identity";
          break;
        }
        layer = resolved;
      }
      reason = add(rule.style, origin, false, layer, treeOrder);
    }
    // The style attribute joins the element scope's group (style_resolver.cc:892-913).
    reason ??= add(scope.inlineStyle, "author", true, tree.layers.order, elementTree);
    for (const animation of scope.animationStyles ?? []) reason ??= add(animation.style, "animation");
    reason ??= add(scope.transitionsStyle, "transition");
    if (reason) return { reason };
    candidates.sort(compare);
    let remaining = [...candidates];
    while (remaining.length) {
      const winner = remaining.at(-1)!;
      if (winner.origin === "animation" && context.resolveAnimation != null) {
        const animated = await context.resolveAnimation(index);
        if (!("base" in animated)) return animated;
        remaining = remaining.filter((c) => c.origin !== "animation");
        continue;
      }
      if (winner.origin === "animation" || winner.origin === "transition")
        return { reason: "interpolated family lost original type" };
      const resolved = await context.resolve(winner.value, winner.shorthand, index);
      if (resolved.kind === "unknown") return { reason: resolved.reason };
      const value = resolved.kind === "invalid" ? "unset" : clean(resolved.value);
      const keyword = parseCssFontFamilyEntries(value);
      const wide = keyword.length === 1 && !keyword[0].quoted ? keyword[0].name.toLowerCase() : "";
      if (wide === "revert") {
        const target = winner.origin === "ua" ? -1 : winner.origin === "user" ? 0 : 1;
        remaining = remaining.filter((c) => naturalOrigin(c.origin) <= target);
        continue;
      }
      if (wide === "revert-layer") {
        const key = layerKey(winner);
        remaining = remaining.filter((c) => compareKeys(layerKey(c), key) < 0);
        continue;
      }
      if (wide === "initial") return { type: "standard" };
      if (wide === "inherit" || wide === "unset") break;
      if (winner.wideOnly) return { reason: "all substitution has no proved CSS-wide result" };
      if (keyword.length && keyword.every((entry) => entry.type === "family-name")) return { type: "concrete" };
      return { reason: "unsupported generic or unresolved family value" };
    }
  }
  return { type: "standard" };
}

/** Type of a family value Blink APPLIES directly — an animation keyframe's
 * authored CSSValue (`CSSDefaultInterpolationType::Apply`). CSS-wide keywords
 * other than `initial` would need the parent/rollback cascade, which a keyframe
 * value does not carry here, so they stay unknown. */
export function classifyAppliedFamily(resolved: FamilyValue): FamilyResolution {
  if (resolved.kind === "unknown") return { reason: resolved.reason };
  if (resolved.kind === "invalid") return { reason: "keyframe family is invalid at computed-value time" };
  const keyword = parseCssFontFamilyEntries(clean(resolved.value));
  const wide = keyword.length === 1 && !keyword[0].quoted ? keyword[0].name.toLowerCase() : "";
  if (wide === "initial") return { type: "standard" };
  if (/^(?:inherit|unset|revert(?:-layer|-rule)?)$/.test(wide))
    return { reason: `keyframe family ${wide} is unproved` };
  if (keyword.length && keyword.every((entry) => entry.type === "family-name")) return { type: "concrete" };
  return { reason: "unsupported generic or unresolved family value" };
}

/** The current renderer consumes captured DOM language, not CSS -webkit-locale.
 * Keep proven family type separate from whether that existing route can use it.
 * CSS locale auto represents an absent FontDescription locale, not DOM lang. */
export function fontLocaleMatchesCapturedLanguage(locale: string | undefined, language: string | undefined): boolean {
  if (locale == null || language == null) return false;
  const values = parseCssFontFamilyEntries(locale);
  if (values.length !== 1) return false;
  const actual =
    !values[0].quoted && values[0].name.toLowerCase() === "auto" ? "" : values[0].quoted ? values[0].name : null;
  return actual != null && actual.toLowerCase() === language.toLowerCase();
}
