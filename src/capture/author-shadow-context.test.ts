import { describe, expect, it, vi } from "vitest";
import type { Page } from "@playwright/test";
import { createAuthorShadowScope, type AuthorShadowContextOptions } from "./author-shadow-context.js";

function transport(admin: "exception" | "pending") {
  let release: () => void = () => undefined;
  const listeners = new Map<string, (event: unknown) => void>();
  const detach = vi.fn(async () => undefined);
  const send = vi.fn(async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
    if (method === "Runtime.enable")
      listeners.get("Runtime.executionContextCreated")?.({
        context: { id: 1, uniqueId: "original", auxData: { isDefault: true, frameId: "main" } },
      });
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
    if (method === "Runtime.evaluate") {
      if (params?.["expression"] === "({})") return { result: { objectId: "carrier" } };
      if (admin === "pending")
        return new Promise((resolve) => {
          release = () => resolve({ result: { objectId: "late-admin" } });
        });
      return { result: { objectId: "exception-object" }, exceptionDetails: { text: "invalid selector" } };
    }
    return {};
  });
  const session = {
    send,
    detach,
    on: (name: string, callback: (event: unknown) => void) => listeners.set(name, callback),
  };
  const page = { context: () => ({ newCDPSession: async () => session }), isClosed: () => false } as unknown as Page;
  return { page, send, detach, release: () => release() };
}

describe("author shadow carrier failure ownership", () => {
  it("releases every failed pre-admin object group without waiting for scope disposal", async () => {
    const { page, send, detach } = transport("exception");
    const scope = createAuthorShadowScope(page);
    for (let index = 0; index < 2; index++) {
      const probe = await scope.prepare("[", { mode: "selected-root", purpose: "test" });
      expect(probe.key).toBeUndefined();
      expect(probe.warnings).toHaveLength(1);
      expect(send.mock.calls.filter(([method]) => method === "Runtime.releaseObjectGroup")).toHaveLength(index + 1);
    }
    await scope.dispose();
    expect(detach).toHaveBeenCalledTimes(1);
  });
  it("detaches within its cleanup bound even when creation never replies", async () => {
    const { page, detach } = transport("pending");
    const scope = createAuthorShadowScope(page, { timeoutMs: 30 });
    const probe = await scope.prepare("#target", { mode: "selected-root", purpose: "test" });
    expect(probe.key).toBeUndefined();
    const start = performance.now();
    await scope.dispose();
    expect(performance.now() - start).toBeLessThan(1500);
    expect(detach).toHaveBeenCalledTimes(1);
    expect(scope.warnings.some((warning) => warning.detail.includes("late cleanup"))).toBe(true);
  });
});

it("refuses malformed primitive purposes before opening transport", async () => {
  const { page, send } = transport("exception");
  const scope = createAuthorShadowScope(page);
  const probe = await scope.prepare("#target", {
    mode: "selected-root",
    purpose: 12,
  } as unknown as AuthorShadowContextOptions);
  expect(probe.key).toBeUndefined();
  expect(send).not.toHaveBeenCalled();
  await scope.dispose();
});
it("closes and releases a late original admin after bounded scope disposal", async () => {
  const { page, send, detach, release } = transport("pending");
  const scope = createAuthorShadowScope(page, { timeoutMs: 30 });
  await scope.prepare("#target", { mode: "selected-root", purpose: "test" });
  await scope.dispose();
  expect(detach).toHaveBeenCalledTimes(1);
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(
    send.mock.calls.some(
      ([method, params]) => method === "Runtime.callFunctionOn" && params?.["objectId"] === "late-admin",
    ),
  ).toBe(true);
  expect(send.mock.calls.filter(([method]) => method === "Runtime.releaseObjectGroup").length).toBeGreaterThanOrEqual(
    2,
  );
});
it.each(["timeout", "exception", "rejection", "release"] as const)(
  "reports %s cleanup uncertainty without exposing raw command data",
  async (fault) => {
    const listeners = new Map<string, (event: unknown) => void>();
    const session = {
      on: (name: string, callback: (event: unknown) => void) => listeners.set(name, callback),
      detach: vi.fn(async () => undefined),
      send: vi.fn(async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
        if (method === "Runtime.enable")
          listeners.get("Runtime.executionContextCreated")?.({
            context: { id: 1, uniqueId: "original", auxData: { isDefault: true, frameId: "main" } },
          });
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
        if (method === "Runtime.evaluate")
          return { result: { objectId: params?.["expression"] === "({})" ? "carrier" : "admin" } };
        if (method === "Runtime.callFunctionOn" && String(params?.["functionDeclaration"]).includes("this.close")) {
          if (fault === "timeout") return new Promise(() => undefined);
          if (fault === "exception") return { exceptionDetails: { text: "source secret not retained" } };
          if (fault === "rejection") throw new Error("raw command data not retained");
        }
        if (method === "Runtime.releaseObjectGroup" && fault === "release") return new Promise(() => undefined);
        return { result: {} };
      }),
    };
    const page = { context: () => ({ newCDPSession: async () => session }), isClosed: () => false } as unknown as Page;
    const scope = createAuthorShadowScope(page);
    const probe = await scope.prepare("#target", { mode: "selected-root", purpose: "test" });
    expect(probe.key).toBeUndefined();
    expect(scope.warnings).toHaveLength(1);
    expect(scope.warnings[0].detail).toContain("owned cleanup confirmation");
    expect(scope.warnings[0].detail).not.toMatch(/secret|raw command/);
    await scope.dispose();
    expect(session.detach).toHaveBeenCalledTimes(1);
  },
);
