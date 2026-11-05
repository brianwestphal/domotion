import { describe, expect, it } from "vitest";
import { installPlaywrightChromium } from "./index.js";

// The auto-install used to be an untimed `spawnSync`, which blocked a library caller's event loop
// and could hang forever on a wedged download. Real child processes stand in for `npx` here.
const node = (script: string) => ({ file: process.execPath, args: ["-e", script] });

describe("installPlaywrightChromium", () => {
  it("resolves when the installer exits 0", async () => {
    await expect(installPlaywrightChromium(10_000, node(""))).resolves.toBeUndefined();
  });

  it("rejects with the manual-install hint on a non-zero exit", async () => {
    await expect(installPlaywrightChromium(10_000, node("process.exit(3)"))).rejects.toThrow(
      /Failed to auto-install Playwright Chromium \(exit code 3\)\. Run 'npx playwright install chromium' manually/,
    );
  });

  it("kills a wedged installer at the deadline without blocking the event loop", async () => {
    let ticks = 0;
    const ticker = setInterval(() => ticks++, 10);
    try {
      await expect(installPlaywrightChromium(300, node("setTimeout(() => {}, 60_000)"))).rejects.toThrow(
        /timed out after 300 ms/,
      );
    } finally {
      clearInterval(ticker);
    }
    expect(ticks).toBeGreaterThan(5);
  });

  it("rejects when the installer cannot be spawned", async () => {
    await expect(installPlaywrightChromium(1_000, { file: "/nonexistent/domotion-npx", args: [] })).rejects.toThrow(
      /Failed to auto-install Playwright Chromium \(spawn .*ENOENT\)/,
    );
  });
});
