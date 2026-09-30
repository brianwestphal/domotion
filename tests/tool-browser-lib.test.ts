import { expect, it, vi } from "vitest";
import type { Browser } from "@playwright/test";

const { launch, close } = vi.hoisted(() => ({ launch: vi.fn(), close: vi.fn() }));
vi.mock("../src/capture/index.js", () => ({ launchChromium: launch }));
vi.mock("../src/test-support/close-browser-safely.js", () => ({ closeBrowserSafely: close }));

import { withBrowser } from "../tools/lib/browser.js";

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
