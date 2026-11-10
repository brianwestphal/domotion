import type { Page } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";
import { captureFontFamilyDeclarationFacts } from "./font-family-declarations-cdp.js";

function harness(failure?: string) {
  const send = vi.fn(async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
    if (
      method === failure ||
      (failure === "attach" &&
        method === "Runtime.callFunctionOn" &&
        params?.arguments != null &&
        (params.arguments as unknown[]).length === 3)
    )
      throw new Error("synthetic failure");
    switch (method) {
      case "DOM.getDocument":
        return { root: { nodeId: 1, nodeType: 9 } };
      case "DOM.resolveNode":
        return { object: { objectId: "document" } };
      case "Runtime.callFunctionOn":
        if (failure === "attach-js" && params?.arguments != null && (params.arguments as unknown[]).length === 3)
          return { result: {}, exceptionDetails: { text: "synthetic failure" } };
        return { result: { objectId: "candidates" } };
      case "Runtime.getProperties":
        return { result: [{ name: "0", value: { objectId: "candidate" } }] };
      case "DOM.requestNode":
        return { nodeId: 2 };
      case "CSS.getMatchedStylesForNode":
        return {
          matchedCSSRules: [
            { rule: { origin: "regular", style: { cssProperties: [{ name: "font-family", value: "Times" }] } } },
          ],
        };
      default:
        return {};
    }
  });
  const detach = vi.fn(async () => undefined);
  const page = {
    frames: () => [],
    context: () => ({ newCDPSession: async () => ({ send, detach }) }),
  } as unknown as Page;
  return { page, send, detach };
}

describe("opaque family declaration probe lifecycle", () => {
  it("releases retained objects and removes its private key", async () => {
    const h = harness();
    const probe = await captureFontFamilyDeclarationFacts(h.page);
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
    const probe = await captureFontFamilyDeclarationFacts(h.page);
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
    const probe = await captureFontFamilyDeclarationFacts(h.page);
    h.send.mockRejectedValue(new Error("target closed"));
    await probe.dispose();
    expect(h.detach).toHaveBeenCalledOnce();
  });
});
