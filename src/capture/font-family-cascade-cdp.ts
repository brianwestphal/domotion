import type { CDPSession } from "@playwright/test";
import { parseCssFontFamilyEntries } from "../font-family-stack.js";
import {
  classifyAppliedFamily,
  resolveMatchedFontFamilyType,
  type FamilyMatched,
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
  assignedSlot?: unknown;
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
/** Authenticate the inspector inheritance path against the pierced DOM before
 * querying node-specific computed custom-property data. Assigned slots/author
 * shadow scopes are intentionally not inferred from ordinary parentElement. */
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
  const ids: number[] = [];
  let record = records.get(nodeId);
  while (record?.node.nodeType === 1) {
    if (record.node.assignedSlot != null)
      return { family: "", resolution: { reason: "composed font inheritance needs native authority" } };
    ids.push(record.node.nodeId);
    record = record.parent;
  }
  if (
    record?.node.nodeType !== 9 ||
    record.node.backendNodeId == null ||
    ids.length !== 1 + (matched.inherited?.length ?? 0)
  )
    return { family: "", resolution: { reason: "font inheritance identity is incomplete" } };
  const treeScopeId = record.node.backendNodeId;
  const { rootLayer } = await session.send("CSS.getLayersForNode", { nodeId });
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
