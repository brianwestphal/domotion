import { expect, it, vi } from "vitest";
import type { Browser } from "@playwright/test";
import { openOwnedBrowser, withBrowser } from "../tools/lib/browser.mjs";

it("closes after a rejected callback and preserves its error", async () => {
  const close = vi.fn().mockResolvedValue(undefined);
  const browser = { close } as unknown as Browser;
  const launch = vi.fn().mockResolvedValue(browser);
  await expect(
    withBrowser(
      async () => {
        throw new Error("probe failed");
      },
      undefined,
      { launch },
    ),
  ).rejects.toThrow("probe failed");
  expect(launch).toHaveBeenCalledExactlyOnceWith(undefined);
  expect(close).toHaveBeenCalledOnce();
});

it("does not run a probe after launch rejection", async () => {
  const run = vi.fn();
  const launch = vi.fn().mockRejectedValue(new Error("launch failed"));
  await expect(withBrowser(run, undefined, { launch })).rejects.toThrow("launch failed");
  expect(run).not.toHaveBeenCalled();
});

it("forwards pinned options and closes an owner once", async () => {
  const close = vi.fn().mockResolvedValue(undefined);
  const browser = { close } as unknown as Browser;
  const launch = vi.fn().mockResolvedValue(browser);
  const options = { executablePath: "/fixture/chromium", headless: true };
  const owner = await openOwnedBrowser(options, { launch, closeTimeoutMs: 20 });
  expect(owner.browser).toBe(browser);
  expect(launch).toHaveBeenCalledExactlyOnceWith(options);
  await owner.close();
  await owner.close();
  expect(close).toHaveBeenCalledOnce();
});

it("returns a successful callback result", async () => {
  const browser = { close: vi.fn().mockResolvedValue(undefined) } as unknown as Browser;
  await expect(
    withBrowser(async (owned) => owned === browser, undefined, { launch: async () => browser }),
  ).resolves.toBe(true);
  expect(browser.close).toHaveBeenCalledOnce();
});
