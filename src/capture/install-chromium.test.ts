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
    // Non-blocking means the caller's event loop gets a turn while the
    // installer is still pending. A synchronous wait (the old `spawnSync`)
    // would settle the call before any turn, so the check below would see it
    // settled. Counting 10 ms timer ticks during the 300 ms deadline instead
    // measured the worker's share of a core: in a loaded suite it saw exactly
    // five (docs/tool-child-process-test-bounds.md).
    let settled = false;
    const install = installPlaywrightChromium(300, node("setTimeout(() => {}, 60_000)")).finally(() => {
      settled = true;
    });
    const pendingAtNextTurn = await new Promise<boolean>((resolve) => setImmediate(() => resolve(!settled)));
    expect(pendingAtNextTurn).toBe(true);
    // The rejection names the deadline only when the child was killed by it.
    await expect(install).rejects.toThrow(/timed out after 300 ms/);
  });

  it("rejects when the installer cannot be spawned", async () => {
    await expect(installPlaywrightChromium(1_000, { file: "/nonexistent/domotion-npx", args: [] })).rejects.toThrow(
      /Failed to auto-install Playwright Chromium \(spawn .*ENOENT\)/,
    );
  });
});
