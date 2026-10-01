import type { Frame, JSHandle, Page } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";
import { createPageRegistry } from "./page-registry.js";

describe("createPageRegistry", () => {
  it("cleans up every tagged frame after a partial evaluation failure and is idempotent", async () => {
    const value = { dispose: vi.fn().mockResolvedValue(undefined) } as unknown as JSHandle<unknown>;
    const good = {
      evaluateHandle: vi.fn().mockResolvedValue(value),
      evaluate: vi.fn().mockResolvedValue(undefined),
    } as unknown as Frame;
    const interrupted = {
      evaluateHandle: vi.fn().mockRejectedValue(new Error("navigation interrupted evaluation")),
      evaluate: vi.fn().mockResolvedValue(undefined),
    } as unknown as Frame;
    const page = { frames: () => [good, interrupted] } as unknown as Page;
    const registry = createPageRegistry(page, "Test");

    await registry.tag(good, () => ({ ready: true }));
    await expect(registry.tag(interrupted, () => ({ ready: false }))).rejects.toThrow("navigation interrupted");
    await registry.dispose();
    await registry.dispose();

    expect(good.evaluate).toHaveBeenCalledTimes(2);
    expect(interrupted.evaluate).toHaveBeenCalledTimes(1);
    expect(value.dispose).toHaveBeenCalledTimes(1);
    await expect(registry.tag(good, () => ({ ready: true }))).rejects.toThrow("disposed");
  });

  it("refuses a frame from another page", async () => {
    const foreign = { evaluateHandle: vi.fn() } as unknown as Frame;
    const page = { frames: () => [] } as unknown as Page;
    const registry = createPageRegistry(page, "Test");
    await expect(registry.tag(foreign, () => null)).rejects.toThrow("outside page registry");
    expect(foreign.evaluateHandle).not.toHaveBeenCalled();
  });
});
