import { beforeEach, expect, it, vi } from "vitest";
import type { Browser } from "@playwright/test";

const { launch, close } = vi.hoisted(() => ({ launch: vi.fn(), close: vi.fn() }));
vi.mock("../src/capture/index.js", () => ({ launchChromium: launch }));
vi.mock("../src/test-support/close-browser-safely.js", () => ({ closeBrowserSafely: close }));

import { openOwnedBrowser, withBrowser } from "../tools/lib/browser.js";

beforeEach(() => {
  launch.mockReset();
  close.mockReset();
});

it("closes an owned browser after a failed tool callback", async () => {
  const browser = { newPage: vi.fn() } as unknown as Browser;
  launch.mockResolvedValue(browser);
  close.mockResolvedValue(undefined);
  await expect(
    withBrowser(async () => {
      throw new Error("report failed");
    }),
  ).rejects.toThrow("report failed");
  expect(close).toHaveBeenCalledExactlyOnceWith(browser);
});

it("returns the callback result and forwards launch options", async () => {
  const browser = { newPage: vi.fn() } as unknown as Browser;
  launch.mockResolvedValue(browser);
  close.mockResolvedValue(undefined);
  const options = { args: ["--site-per-process"], headless: true };
  await expect(withBrowser(async (owned) => ({ version: owned === browser }), options)).resolves.toEqual({
    version: true,
  });
  expect(launch).toHaveBeenCalledWith(options);
  expect(close).toHaveBeenCalledExactlyOnceWith(browser);
});

it("does not run the callback or close a browser when launch fails", async () => {
  launch.mockRejectedValue(new Error("launch failed"));
  const run = vi.fn();
  await expect(withBrowser(run)).rejects.toThrow("launch failed");
  expect(run).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
});

it("uses a pinned launch factory and close deadline when supplied", async () => {
  const browser = { newPage: vi.fn() } as unknown as Browser;
  const pinnedLaunch = vi.fn().mockResolvedValue(browser);
  close.mockResolvedValue(undefined);
  const options = { executablePath: "/fixture/chromium", headless: true };
  await withBrowser(async () => undefined, options, { launch: pinnedLaunch, closeTimeoutMs: 10_000 });
  expect(pinnedLaunch).toHaveBeenCalledExactlyOnceWith(options);
  expect(launch).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledExactlyOnceWith(browser, 10_000);
});

it("closes a returned owner only once when callers repeat cleanup", async () => {
  const browser = { newPage: vi.fn() } as unknown as Browser;
  launch.mockResolvedValue(browser);
  close.mockResolvedValue(undefined);
  const owner = await openOwnedBrowser();
  expect(owner.browser).toBe(browser);
  await owner.close();
  await owner.close();
  expect(close).toHaveBeenCalledExactlyOnceWith(browser);
});
