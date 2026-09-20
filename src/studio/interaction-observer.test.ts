import type { ElementHandle, Locator, Page } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";

import { observeStudioInteraction } from "./interaction-observer.js";

function locatorWith(handle: ElementHandle<Element> | null): Locator {
  return { elementHandle: vi.fn().mockResolvedValue(handle) } as unknown as Locator;
}

describe("Studio interaction observation boundary", () => {
  it.each([
    ["non-finite settle time", { settleMs: Number.POSITIVE_INFINITY }],
    ["negative debounce", { debounceMs: -1 }],
    ["negative baseline", { baselineMs: -1 }],
    ["fractional node limit", { maxNodes: 1.5 }],
    ["empty node limit", { maxNodes: 0 }],
  ])("rejects %s before touching the target", async (_name, override) => {
    const target = locatorWith(null);
    await expect(observeStudioInteraction({} as Page, {
      eventId: "invalid",
      path: "$.invalid",
      target,
      ...override,
    }, () => undefined)).rejects.toThrow(
      "Studio interaction observation timing must be finite and maxNodes must be a positive integer",
    );
    expect(target.elementHandle).not.toHaveBeenCalled();
  });

  it("fails clearly when the resolved target is detached", async () => {
    await expect(observeStudioInteraction({} as Page, {
      eventId: "missing",
      path: "$.events.missing",
      target: locatorWith(null),
    }, () => undefined)).rejects.toThrow(
      "Studio interaction observation $.events.missing: target is not attached",
    );
  });

  it("disposes every acquired handle and attempts cleanup when setup fails", async () => {
    const targetHandle = { dispose: vi.fn().mockResolvedValue(undefined) } as unknown as ElementHandle<Element>;
    const relatedHandle = { dispose: vi.fn().mockResolvedValue(undefined) } as unknown as ElementHandle<Element>;
    const setupError = new Error("controlled setup failure");
    const evaluate = vi.fn()
      .mockRejectedValueOnce(setupError)
      .mockRejectedValueOnce(new Error("controlled cleanup failure"));

    await expect(observeStudioInteraction({ evaluate } as unknown as Page, {
      eventId: "setup",
      path: "$.events.setup",
      target: locatorWith(targetHandle),
      relatedTargets: [locatorWith(relatedHandle)],
    }, () => undefined)).rejects.toBe(setupError);

    expect(targetHandle.dispose).toHaveBeenCalledOnce();
    expect(relatedHandle.dispose).toHaveBeenCalledOnce();
    expect(evaluate).toHaveBeenCalledTimes(2);
  });
});
