import type { Page } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";
import { captureFontFamilyDeclarationFacts } from "./font-family-declarations-cdp.js";

function harness(failure?: string, options: { value?: string; fontLocale?: string; language?: string } = {}) {
  const send = vi.fn(async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
    if (
      method === failure ||
      (failure === "attach" &&
        method === "Runtime.callFunctionOn" &&
        params?.arguments != null &&
        (params.arguments as unknown[]).length >= 3)
    )
      throw new Error("synthetic failure");
    switch (method) {
      case "DOM.getDocument":
        return {
          root: {
            nodeId: 1,
            backendNodeId: 100,
            nodeType: 9,
            children: [{ nodeId: 2, backendNodeId: 200, nodeType: 1 }],
          },
        };
      case "DOM.resolveNode":
        return { object: { objectId: "document" } };
      case "Runtime.callFunctionOn":
        if (String(params?.functionDeclaration).includes("font provenance language"))
          return { result: { value: options.language ?? "" } };
        if (failure === "attach-js" && params?.arguments != null && (params.arguments as unknown[]).length >= 3)
          return { result: {}, exceptionDetails: { text: "synthetic failure" } };
        return { result: { objectId: "candidates" } };
      case "Runtime.getProperties":
        return { result: [{ name: "0", value: { objectId: "candidate" } }] };
      case "DOM.requestNode":
        return { nodeId: 2 };
      case "CSS.getMatchedStylesForNode":
        return {
          matchedCSSRules: [
            {
              rule: {
                origin: "regular",
                originTreeScopeNodeId: 100,
                style: { cssProperties: [{ name: "font-family", value: options.value ?? "Times" }] },
              },
            },
          ],
        };
      case "CSS.getLayersForNode":
        if (failure === "new-native") throw new Error("synthetic new native failure");
        return { rootLayer: { name: "implicit outer layer", order: 0 } };
      case "CSS.getComputedStyleForNode":
        return {
          computedStyle: [
            { name: "font-family", value: "Times" },
            { name: "-webkit-locale", value: options.fontLocale ?? "auto" },
          ],
        };
      case "CSS.getLonghandProperties":
        return { longhandProperties: [{ name: "font-family", value: "Times" }] };
      default:
        return {};
    }
  });
  const detach = vi.fn(async () => undefined);
  const page = {
    frames: () => [],
    evaluate: async () => "",
    context: () => ({ newCDPSession: async () => ({ send, detach }) }),
  } as unknown as Page;
  return { page, send, detach };
}

describe("opaque family declaration probe lifecycle", () => {
  it("releases retained objects and removes its private key", async () => {
    const h = harness();
    const probe = await captureFontFamilyDeclarationFacts(h.page, { literalOnly: true });
    expect(probe.warnings).toEqual([]);
    expect(h.detach).not.toHaveBeenCalled();
    await probe.dispose();
    await probe.dispose();
    expect(h.send).toHaveBeenCalledWith(
      "Runtime.callFunctionOn",
      expect.objectContaining({ objectId: "candidate", functionDeclaration: "function(key) { delete this[key]; }" }),
    );
    expect(h.send).toHaveBeenCalledWith(
      "Runtime.releaseObjectGroup",
      expect.objectContaining({ objectGroup: expect.stringContaining(probe.propertyKey) }),
    );
    expect(h.detach).toHaveBeenCalledOnce();
  });
  it.each([
    "DOM.enable",
    "CSS.enable",
    "DOM.getDocument",
    "DOM.resolveNode",
    "Runtime.getProperties",
    "DOM.requestNode",
    "CSS.getMatchedStylesForNode",
    "CSS.getAnimatedStylesForNode",
    "attach",
    "attach-js",
  ])("reports %s failure and still detaches", async (failure) => {
    const h = harness(failure);
    const probe = await captureFontFamilyDeclarationFacts(h.page, { literalOnly: true });
    expect(probe.warnings).toHaveLength(1);
    expect(probe.warnings[0].detail).toContain("synthetic failure");
    await probe.dispose();
    expect(h.detach).toHaveBeenCalledOnce();
    if (failure === "attach" || failure === "attach-js")
      expect(h.send).toHaveBeenCalledWith(
        "Runtime.callFunctionOn",
        expect.objectContaining({
          objectId: "candidate",
          functionDeclaration: "function(key) { delete this[key]; }",
        }),
      );
  });
  it("detaches even when key removal and object release fail", async () => {
    const h = harness();
    const probe = await captureFontFamilyDeclarationFacts(h.page, { literalOnly: true });
    h.send.mockRejectedValue(new Error("target closed"));
    await probe.dispose();
    expect(h.detach).toHaveBeenCalledOnce();
  });
});

describe("extended native family provenance lifecycle", () => {
  it("runs extended provenance by default and retains the original literal witness", async () => {
    const h = harness();
    const probe = await captureFontFamilyDeclarationFacts(h.page);
    expect(probe.warnings).toEqual([]);
    expect(h.send).toHaveBeenCalledWith("CSS.getLayersForNode", { nodeId: 2 });
    const install = h.send.mock.calls.find(
      ([method, params]) =>
        method === "Runtime.callFunctionOn" && (params?.arguments as unknown[] | undefined)?.length === 4,
    );
    expect(install?.[1]?.arguments).toMatchObject([
      { value: probe.propertyKey },
      { value: true },
      { value: [] },
      { value: { family: "Times", type: "concrete", usable: true, fontLocale: "auto", language: "", pseudos: {} } },
    ]);
    await probe.dispose();
    expect(h.detach).toHaveBeenCalledOnce();
  });
  it("does not erase valid literal provenance when an extension query fails", async () => {
    const h = harness("new-native");
    const probe = await captureFontFamilyDeclarationFacts(h.page);
    expect(probe.warnings).toHaveLength(1);
    const install = h.send.mock.calls.find(
      ([method, params]) =>
        method === "Runtime.callFunctionOn" && (params?.arguments as unknown[] | undefined)?.length === 4,
    );
    expect(install?.[1]?.arguments).toMatchObject([
      { value: probe.propertyKey },
      { value: true },
      { value: [] },
      { value: null },
    ]);
    await probe.dispose();
    expect(h.detach).toHaveBeenCalledOnce();
  });
});

describe("computed locale standard-family usability (DM-PJG8E9)", () => {
  it.each([
    { fontLocale: '\"ja\"', usable: true },
    { fontLocale: "auto", usable: false },
  ])(
    "keeps classification separate from explicit/default locale authority: $fontLocale",
    async ({ fontLocale, usable }) => {
      const h = harness(undefined, { value: "initial", fontLocale, language: "en" });
      const probe = await captureFontFamilyDeclarationFacts(h.page);
      const install = h.send.mock.calls.find(
        ([method, params]) =>
          method === "Runtime.callFunctionOn" && (params?.arguments as unknown[] | undefined)?.length === 4,
      );
      expect(install?.[1]?.arguments).toMatchObject([
        { value: probe.propertyKey },
        { value: false },
        { value: [] },
        { value: { type: "standard", usable, fontLocale, language: "en" } },
      ]);
      expect(probe.warnings.length).toBe(usable ? 0 : 1);
      await probe.dispose();
      expect(h.detach).toHaveBeenCalledOnce();
    },
  );
});
