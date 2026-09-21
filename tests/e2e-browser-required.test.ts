import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { verifyRequiredE2EBrowser } from "./e2e-browser-required.global.js";

describe("required Chromium E2E preflight", () => {
  it("fails instead of allowing browser-unavailable suites to report green", async () => {
    const unavailable = new Error("controlled Chromium launch failure");
    await expect(
      verifyRequiredE2EBrowser(async () => {
        throw unavailable;
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("Required Chromium E2E preflight failed"),
      cause: unavailable,
    });
  });

  it("closes a successful preflight browser", async () => {
    const close = vi.fn(async () => undefined);
    await verifyRequiredE2EBrowser(async () => ({ close }));
    expect(close).toHaveBeenCalledOnce();
  });

  it("is wired into the authoritative E2E config", () => {
    const config = readFileSync(resolve("vitest.e2e.config.ts"), "utf8");
    expect(config).toContain(`globalSetup: ["./tests/e2e-browser-required.global.ts"]`);
  });
});
