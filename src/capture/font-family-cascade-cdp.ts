import type { CDPSession } from "@playwright/test";
import { parseCssFontFamilyEntries } from "../font-family-stack.js";
import {
  classifyAppliedFamily,
  resolveMatchedFontFamilyType,
  type FamilyMatched,
  type FamilyTreeContext,
  type NativeFamilyLayers,
  type FamilyResolution,
} from "./font-family-cascade.js";
import { substituteComputedFontVariables, type FamilyValue } from "./font-family-values.js";
import { readPageFamilyAnimations, resolveAnimatedFamilyType } from "./font-family-animation-cdp.js";

export interface FamilyDomNode {
  nodeId: number;
  backendNodeId?: number;
  nodeType: number;
  pseudoType?: string;
  shadowRootType?: string;
  assignedSlot?: { backendNodeId?: number };
  children?: FamilyDomNode[];
  contentDocument?: FamilyDomNode;
  shadowRoots?: FamilyDomNode[];
  pseudoElements?: FamilyDomNode[];
}
export interface FamilyDomRecord {
  node: FamilyDomNode;
  parent?: FamilyDomRecord;
}
export function familyDomRecords(root: FamilyDomNode): Map<number, FamilyDomRecord> {
  const records = new Map<number, FamilyDomRecord>();
  const visit = (node: FamilyDomNode, parent?: FamilyDomRecord) => {
    const record = { node, parent };
    records.set(node.nodeId, record);
    for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? []), ...(node.pseudoElements ?? [])])
      visit(child, record);
    if (node.contentDocument) visit(node.contentDocument, record);
  };
  visit(root);
  return records;
}
export interface NativeFamilyResult {
  family: string;
  fontLocale?: string;
  resolution: FamilyResolution;
}
type FlatTreeWalk = { chain: FamilyDomRecord[]; document: FamilyDomRecord } | { reason: string };

/**
 * Walk from `nodeId` to its document along the flat tree, the parent chain the
 * inspector's `inherited` list follows: a slotted node's parent is its
 * assigned slot, and a shadow root's children continue at the host.
 */
function flatTreeChain(
  records: ReadonlyMap<number, FamilyDomRecord>,
  byBackend: ReadonlyMap<number, FamilyDomRecord>,
  nodeId: number,
): FlatTreeWalk {
  const chain: FamilyDomRecord[] = [];
  let record = records.get(nodeId);
  while (record?.node.nodeType === 1) {
    chain.push(record);
    if (chain.length > 64) return { reason: "font inheritance depth exceeds budget" };
    const slot = record.node.assignedSlot;
    if (slot != null) {
      record = slot.backendNodeId == null ? undefined : byBackend.get(slot.backendNodeId);
      if (record?.node.nodeType !== 1) return { reason: "assigned slot is not in the pierced document" };
      continue;
    }
    const parent: FamilyDomRecord | undefined = record.parent;
    if (parent?.node.nodeType === 11) {
      record = parent.parent;
      if (record?.node.nodeType !== 1) return { reason: "shadow root has no host element" };
      continue;
    }
    if (parent?.node.nodeType === 1 && hostsAuthorShadow(parent.node))
      return { reason: "unslotted light-DOM child is outside the flat tree" };
    record = parent;
  }
  if (record?.node.nodeType !== 9 || record.node.backendNodeId == null)
    return { reason: "font inheritance identity is incomplete" };
  return { chain, document: record };
}

function hostsAuthorShadow(node: FamilyDomNode): boolean {
  return (node.shadowRoots ?? []).some((root) => root.shadowRootType !== "user-agent");
}

/** The document or shadow root record that contains `record`. */
function treeScopeOf(record: FamilyDomRecord): FamilyDomRecord | undefined {
  let current = record.parent;
  while (current != null && current.node.nodeType !== 9 && current.node.nodeType !== 11) current = current.parent;
  return current;
}

/**
 * The tree contexts `StyleResolver::MatchAuthorRules` visits for one element,
 * in `tree_order` (style_resolver.cc:1039-1047, Chromium 7d859f27): its own
 * shadow root (`MatchHostRules`, :716-730), each assigned slot's scope with the
 * deepest slot first (`MatchSlottedRules`, :773-799), its own scope
 * (`MatchElementScopeRules`, :892-913), then the enclosing scopes outward
 * (`MatchOuterScopeRules`, :915-1037). A pseudo-element matches the first two
 * and the last from its originating element. Elements of a user-agent shadow
 * tree are refused: `MatchElementScopeRules` can then report rules under a
 * different scope than the group's tree order (`ScopedResolverFor`).
 */
function treeContextFor(
  record: FamilyDomRecord,
  byBackend: ReadonlyMap<number, FamilyDomRecord>,
  layers: NativeFamilyLayers,
): FamilyTreeContext | { reason: string } {
  const originating = record.node.pseudoType != null ? record.parent : record;
  const scope = treeScopeOf(record);
  if (originating == null || scope?.node.backendNodeId == null)
    return { reason: "font inheritance identity is incomplete" };
  if (scope.node.shadowRootType === "user-agent") return { reason: "user-agent shadow tree order is unproved" };
  const treeScopes: number[] = [];
  const own = (originating.node.shadowRoots ?? []).find((root) => root.shadowRootType !== "user-agent");
  if (own?.backendNodeId != null) treeScopes.push(own.backendNodeId);
  const slotted: number[] = [];
  for (let slot = originating.node.assignedSlot; slot != null;) {
    const slotRecord = slot.backendNodeId == null ? undefined : byBackend.get(slot.backendNodeId);
    const slotScope = slotRecord == null ? undefined : treeScopeOf(slotRecord);
    if (slotRecord == null || slotScope?.node.backendNodeId == null)
      return { reason: "assigned slot is not in the pierced document" };
    slotted.push(slotScope.node.backendNodeId);
    slot = slotRecord.node.assignedSlot;
  }
  treeScopes.push(...slotted.reverse(), scope.node.backendNodeId);
  for (let outer = treeScopeOf(originating); outer?.node.nodeType === 11;) {
    const host = outer.parent;
    outer = host == null ? undefined : treeScopeOf(host);
    if (outer?.node.backendNodeId == null) return { reason: "shadow root has no host element" };
    treeScopes.push(outer.node.backendNodeId);
  }
  return { treeScopes, elementScope: scope.node.backendNodeId, layers };
}

/** Authenticate the inspector inheritance path against the pierced DOM's flat
 * tree before querying node-specific computed custom-property data, and derive
 * each scope's tree contexts from the same records. */
export async function nativeFontFamilyType(
  session: CDPSession,
  nodeId: number,
  matched: FamilyMatched,
  records: ReadonlyMap<number, FamilyDomRecord>,
): Promise<NativeFamilyResult> {
  const deadline = performance.now() + 1500;
  const ensureDeadline = () => {
    if (performance.now() >= deadline) throw new Error("native family provenance deadline expired");
  };
  const byBackend = new Map<number, FamilyDomRecord>();
  for (const record of records.values())
    if (record.node.backendNodeId != null) byBackend.set(record.node.backendNodeId, record);
  const walk = flatTreeChain(records, byBackend, nodeId);
  if ("reason" in walk) return { family: "", resolution: { reason: walk.reason } };
  const ids = walk.chain.map((record) => record.node.nodeId);
  if (ids.length !== 1 + (matched.inherited?.length ?? 0))
    return { family: "", resolution: { reason: "font inheritance identity is incomplete" } };
  const treeScopeId = walk.document.node.backendNodeId!;
  const { rootLayer } = await session.send("CSS.getLayersForNode", { nodeId });
  const ownScope = treeScopeOf(walk.chain[0]);
  const treeContexts: FamilyTreeContext[] = [];
  for (let index = 0; index < walk.chain.length; index++) {
    const record = walk.chain[index];
    let layers = rootLayer as NativeFamilyLayers;
    // Each tree scope has its own CascadeLayerMap; only ask again for an
    // ancestor in another scope whose rules actually name a layer.
    const scope = index === 0 ? matched : matched.inherited?.[index - 1];
    const layered = scope?.matchedCSSRules?.some((row) => (row.rule?.layers?.length ?? 0) > 0) === true;
    if (index > 0 && layered && treeScopeOf(record) !== ownScope) {
      ensureDeadline();
      layers = (await session.send("CSS.getLayersForNode", { nodeId: record.node.nodeId }))
        .rootLayer as NativeFamilyLayers;
    }
    const context = treeContextFor(record, byBackend, layers);
    if ("reason" in context) return { family: "", resolution: { reason: context.reason } };
    treeContexts.push(context);
  }
  const computed = new Map<number, Map<string, string>>();
  const valuesFor = async (scope: number) => {
    ensureDeadline();
    if (!computed.has(scope)) {
      const result = await session.send("CSS.getComputedStyleForNode", { nodeId: ids[scope] });
      if (result.computedStyle.length > 4096) throw new Error("Computed font context exceeded property budget");
      computed.set(scope, new Map(result.computedStyle.map((p) => [p.name, p.value])));
    }
    return computed.get(scope)!;
  };
  const own = await valuesFor(0),
    family = own.get("font-family") ?? "";
  if (family === "") return { family, resolution: { reason: "native computed family is unavailable" } };
  const resolve = async (value: string, shorthand: boolean, scope: number): Promise<FamilyValue> => {
    const vars = await valuesFor(scope);
    const substituted = substituteComputedFontVariables(
      value,
      new Map([...vars].filter(([name]) => name.startsWith("--"))),
    );
    if (substituted.kind !== "value") return substituted;
    // A fully substituted CSS-wide value is applied as such, not converted
    // through a computed-family serialization which would erase its type.
    const clean = substituted.value.replace(/\/\*[\s\S]*?\*\//g, " ").trim();
    const words = parseCssFontFamilyEntries(clean);
    if (words.length === 1 && !words[0].quoted && /^(?:initial|inherit|unset|revert(?:-layer)?)$/i.test(words[0].name))
      return { kind: "value", value: words[0].name };
    ensureDeadline();
    const parsed = await session.send("CSS.getLonghandProperties", {
      shorthandName: "font",
      value: shorthand ? substituted.value : `16px ${substituted.value}`,
    });
    const families = parsed.longhandProperties.filter((p) => p.name === "font-family");
    if (families.length === 0) return { kind: "invalid" };
    if (families.length !== 1 || families[0].value === "")
      return { kind: "unknown", reason: "native pending font shorthand did not resolve" };
    return { kind: "value", value: families[0].value };
  };
  const resolution = await resolveMatchedFontFamilyType(matched, {
    layers: rootLayer as NativeFamilyLayers,
    treeScopeId,
    treeContexts,
    resolve,
    // The animated value keeps its authored keyframe's type (Blink applies the
    // keyframe CSSValue itself); recover that keyframe natively. Pseudo-element
    // targets have no exact animation identity here and stay refused.
    async resolveAnimation(scope) {
      ensureDeadline();
      const node = records.get(ids[scope])?.node;
      if (node == null || node.pseudoType != null) return { reason: "interpolated family lost original type" };
      const rules =
        scope === 0
          ? matched.cssKeyframesRules
          : (await session.send("CSS.getMatchedStylesForNode", { nodeId: ids[scope] })).cssKeyframesRules;
      ensureDeadline();
      const animations = await readPageFamilyAnimations(session, ids[scope]);
      return resolveAnimatedFamilyType(animations, rules, async (value, shorthand) =>
        classifyAppliedFamily(await resolve(value, shorthand, scope)),
      );
    },
  });
  return { family, fontLocale: own.get("-webkit-locale"), resolution };
}
