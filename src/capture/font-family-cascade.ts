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
export interface FamilyMatched extends FamilyScope {
  inherited?: FamilyScope[];
}
export interface NativeFamilyLayers {
  name: string;
  order: number;
  subLayers?: NativeFamilyLayers[];
}
export interface FamilyCascadeContext {
  layers: NativeFamilyLayers;
  /** Only a single authenticated document tree is admitted by this resolver. */
  treeScopeId: number;
  resolve(value: string, shorthand: boolean, scope: number): Promise<FamilyValue>;
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
const layerKey = (c: Candidate) => [naturalOrigin(c.origin), Number(c.inline), c.layer];
const compareKeys = (a: number[], b: number[]) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
};
const compare = (a: Candidate, b: Candidate) =>
  compareKeys(
    [major(a), Number(a.inline), a.important ? -a.layer : a.layer, a.order],
    [major(b), Number(b.inline), b.important ? -b.layer : b.layer, b.order],
  );
const clean = (value: string) => value.replace(/\/\*[\s\S]*?\*\//g, " ").trim();
function canonicalFamily(
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
  const layers = new Map<string, number>();
  if (!Number.isSafeInteger(context.layers.order)) return { reason: "unavailable native layer order" };
  for (const layer of context.layers.subLayers ?? []) {
    if (layer.subLayers?.length || !layer.name || layers.has(layer.name) || !Number.isSafeInteger(layer.order))
      return { reason: "unsupported nested or anonymous layer authority" };
    layers.set(layer.name, layer.order);
  }
  const scopes = [matched, ...(matched.inherited ?? [])];
  if (scopes.length > 64) return { reason: "font inheritance depth exceeds budget" };
  for (let index = 0; index < scopes.length; index++) {
    const scope = scopes[index];
    if (!Array.isArray(scope.matchedCSSRules)) return { reason: "incomplete matched font rules" };
    const candidates: Candidate[] = [];
    let order = 0;
    const add = (
      style: FamilyStyle | undefined,
      origin: Origin,
      inline = false,
      layer = context.layers.order,
    ): string | undefined => {
      const entries = canonicalFamily(style);
      if (typeof entries === "string") return entries;
      for (const entry of entries) candidates.push({ ...entry, origin, inline, layer, order: order++ });
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
      if (origin !== "ua" && rule.originTreeScopeNodeId !== context.treeScopeId) {
        reason = "unproved font tree-scope order";
        break;
      }
      let layer = context.layers.order;
      if (rule.layers?.length) {
        if (rule.layers.length !== 1 || !rule.layers[0].text || !layers.has(rule.layers[0].text)) {
          reason = "unproved font layer identity";
          break;
        }
        layer = layers.get(rule.layers[0].text)!;
      }
      reason = add(rule.style, origin, false, layer);
    }
    reason ??= add(scope.inlineStyle, "author", true);
    for (const animation of scope.animationStyles ?? []) reason ??= add(animation.style, "animation");
    reason ??= add(scope.transitionsStyle, "transition");
    if (reason) return { reason };
    candidates.sort(compare);
    let remaining = [...candidates];
    while (remaining.length) {
      const winner = remaining.at(-1)!;
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
