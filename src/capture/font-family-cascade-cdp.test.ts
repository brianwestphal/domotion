import type { CDPSession } from "@playwright/test";
import { afterEach, expect, it, vi } from "vitest";
import { withTimeout } from "../utils/with-timeout.js";
import { familyDomRecords, nativeFontFamilyType, type FamilyDomNode } from "./font-family-cascade-cdp.js";
import type { FamilyMatched } from "./font-family-cascade.js";
const root: FamilyDomNode = {
  nodeId: 1,
  backendNodeId: 100,
  nodeType: 9,
  children: [{ nodeId: 2, backendNodeId: 200, nodeType: 1 }],
};
const matched = (value: string): FamilyMatched => ({
  matchedCSSRules: [
    {
      rule: {
        origin: "regular",
        originTreeScopeNodeId: 100,
        style: { cssProperties: [{ name: "font-family", value }] },
      },
    },
  ],
});
function harness() {
  const send = vi.fn(async (method: string) => {
    if (method === "CSS.getLayersForNode") return { rootLayer: { name: "implicit outer layer", order: 0 } };
    if (method === "CSS.getComputedStyleForNode")
      return {
        computedStyle: [
          { name: "font-family", value: "Times" },
          { name: "-webkit-locale", value: '"ja"' },
          { name: "--face", value: "Times" },
        ],
      };
    if (method === "CSS.getLonghandProperties")
      return { longhandProperties: [{ name: "font-family", value: "Times" }] };
    throw Error("Unexpected family query");
  });
  return { send, session: { send } as unknown as CDPSession };
}
afterEach(() => vi.useRealTimers());
it("distinguishes native declaration type while computed names stay identical", async () => {
  const h = harness(),
    records = familyDomRecords(root);
  expect(await nativeFontFamilyType(h.session, 2, matched("initial"), records)).toEqual({
    family: "Times",
    fontLocale: '"ja"',
    resolution: { type: "standard" },
  });
  expect(await nativeFontFamilyType(h.session, 2, matched("var(--face)"), records)).toEqual({
    family: "Times",
    fontLocale: '"ja"',
    resolution: { type: "concrete" },
  });
  expect(h.send).toHaveBeenCalledWith("CSS.getLonghandProperties", {
    shorthandName: "font",
    value: "16px /**/Times/**/",
  });
  expect(h.send.mock.calls.map((c) => c[0]).every((method) => method.startsWith("CSS."))).toBe(true);
});
it("declines slot, shadow and missing inheritance identity before querying values", async () => {
  for (const tree of [
    { ...root, children: [{ nodeId: 2, nodeType: 1, assignedSlot: { backendNodeId: 500 } }] },
    { ...root, children: [{ nodeId: 3, nodeType: 11, children: [{ nodeId: 2, nodeType: 1 }] }] },
    { ...root, backendNodeId: undefined },
  ]) {
    const h = harness();
    expect(
      (await nativeFontFamilyType(h.session, 2, matched("initial"), familyDomRecords(tree))).resolution,
    ).toMatchObject({ reason: expect.any(String) });
    expect(h.send).not.toHaveBeenCalled();
  }
  const h = harness();
  expect(
    (
      await nativeFontFamilyType(
        h.session,
        2,
        { ...matched("initial"), inherited: [matched("Times")] },
        familyDomRecords(root),
      )
    ).resolution,
  ).toMatchObject({ reason: expect.any(String) });
  expect(h.send).not.toHaveBeenCalled();
});
it("does not schedule more native queries after a bounded late input", async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const h = harness();
  h.send.mockImplementation(
    async () =>
      new Promise((resolve) => {
        release = () => resolve({ rootLayer: { name: "implicit", order: 0 } });
      }),
  );
  const operation = nativeFontFamilyType(h.session, 2, matched("initial"), familyDomRecords(root));
  const rejection = expect(operation).rejects.toThrow("deadline expired");
  const bound = withTimeout(operation, 1500);
  await vi.advanceTimersByTimeAsync(1501);
  expect(await bound).toBeUndefined();
  release();
  await rejection;
  expect(h.send).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
