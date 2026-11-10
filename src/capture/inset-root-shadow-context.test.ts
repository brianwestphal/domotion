import { expect, it } from "vitest";
import { rootHasAuthorShadowContext, type ShadowContextDomNode } from "./inset-root-shadow-context.js";

const element = (
  backendNodeId: number,
  children: ShadowContextDomNode[] = [],
  shadowRoots?: ShadowContextDomNode[],
): ShadowContextDomNode => ({ backendNodeId, nodeType: 1, children, shadowRoots });
const document = (children: ShadowContextDomNode[]): ShadowContextDomNode => ({
  backendNodeId: 1,
  nodeType: 9,
  children,
});
const shadow = (shadowRootType: string): ShadowContextDomNode => ({
  backendNodeId: 50,
  nodeType: 11,
  shadowRootType,
  children: [],
});

it("recognizes a unique ordinary selected node", () => {
  expect(rootHasAuthorShadowContext(document([element(2, [element(3)])]), 3)).toBe(false);
});
it.each(["open", "closed"])("refuses a light-DOM selected child of an %s author host", (mode) => {
  expect(rootHasAuthorShadowContext(document([element(2, [element(3)], [shadow(mode)])]), 3)).toBe(true);
});
it("sees an empty closed root attached to the selected host itself", () => {
  expect(rootHasAuthorShadowContext(document([element(2, [], [shadow("closed")])]), 2)).toBe(true);
});
it("does not classify user-agent decoration as author composition", () => {
  expect(rootHasAuthorShadowContext(document([element(2, [element(3)], [shadow("user-agent")])]), 3)).toBe(false);
});
it("does not transfer an unrelated host's author-shadow fact", () => {
  expect(rootHasAuthorShadowContext(document([element(2, [], [shadow("closed")]), element(3)]), 3)).toBe(false);
});
it("rejects unknown shadow provenance", () => {
  expect(rootHasAuthorShadowContext(document([element(2, [], [shadow("unknown")])]), 2)).toBeNull();
});
it("rejects absent or ambiguous selected backend identity", () => {
  expect(rootHasAuthorShadowContext(document([element(2)]), 3)).toBeNull();
  expect(rootHasAuthorShadowContext(document([element(2), element(2)]), 2)).toBeNull();
});
it("rejects an incomplete subtree supplied in place of the document", () => {
  expect(rootHasAuthorShadowContext(element(2), 2)).toBeNull();
});
it("refuses cycles and an expired Node deadline", () => {
  const cyclic = element(2);
  cyclic.children = [cyclic];
  expect(rootHasAuthorShadowContext(document([cyclic]), 2)).toBeNull();
  expect(rootHasAuthorShadowContext(document([element(2)]), 2, performance.now() - 1)).toBeNull();
});
