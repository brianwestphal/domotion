import { describe, expect, it, vi } from "vitest";
import type { Page } from "@playwright/test";
import { explicitGlobalFontHinting, observeImageFontHinting } from "./image-font-hinting.js";

const shell = "/opt/chromium/chrome-headless-shell";
describe("observed image font hinting", () => {
  it("keeps normal multiprocess, custom Chrome and unknown flags conservative", () => {
    expect(explicitGlobalFontHinting([shell, "--no-sandbox", "--font-render-hinting=medium"])).toBeUndefined();
    expect(
      explicitGlobalFontHinting(["/bin/chrome", "--single-process", "--font-render-hinting=none"]),
    ).toBeUndefined();
    expect(explicitGlobalFontHinting([shell, "--single-process"])).toBeUndefined();
    expect(explicitGlobalFontHinting([shell, "--single-process", "--font-render-hinting=max"])).toBeUndefined();
  });

  it("reads explicit modes and final duplicate values from an actual command line", () => {
    for (const mode of ["none", "slight", "medium", "full"]) {
      expect(explicitGlobalFontHinting([shell, "--single-process", `--font-render-hinting=${mode}`])).toBe(mode);
    }
    expect(
      explicitGlobalFontHinting([
        shell,
        "--single-process",
        "--font-render-hinting=full",
        "--font-render-hinting=none",
      ]),
    ).toBe("none");
  });

  it("observes custom launches through CDP and detaches without exposing arguments", async () => {
    const detach = vi.fn(async () => undefined);
    const send = vi.fn(async () => ({
      arguments: [shell, "--single-process", "--font-render-hinting=none", "--private-token=secret"],
    }));
    const context = { newCDPSession: vi.fn(async () => ({ send, detach })) };
    const page = { context: () => context } as unknown as Page;
    expect(await observeImageFontHinting(page)).toBe("none");
    expect(await observeImageFontHinting(page)).toBe("none");
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith("Browser.getBrowserCommandLine");
    expect(detach).toHaveBeenCalledOnce();
  });

  it("leaves denied command-line queries unknown and detaches", async () => {
    const detach = vi.fn(async () => undefined);
    const context = {
      newCDPSession: async () => ({
        send: async () => {
          throw new Error("automation disabled");
        },
        detach,
      }),
    };
    expect(await observeImageFontHinting({ context: () => context } as unknown as Page)).toBeUndefined();
    expect(detach).toHaveBeenCalledOnce();
  });
});
