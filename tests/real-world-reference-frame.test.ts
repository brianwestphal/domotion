import type { Page } from "@playwright/test";
import { beforeEach, expect, it, vi } from "vitest";
const calls = vi.hoisted(() => ({ events: [] as string[], prime: vi.fn(), freeze: vi.fn(), dispose: vi.fn() }));
vi.mock("./real-world-webgl-preflight.js", () => ({ primeOffscreenCanvases: calls.prime }));
vi.mock("./real-world-webgl-freeze.js", () => ({ freezeWebGlOutput: calls.freeze }));
import { captureRealWorldReferenceFrame } from "./real-world-reference-frame.js";

beforeEach(() => {
  calls.events.length = 0;
  calls.dispose.mockReset();
  calls.dispose.mockResolvedValue(undefined);
  calls.prime.mockImplementation(async () => {
    calls.events.push("prime");
    return { primed: 1, failed: 0, skipped: 0 };
  });
  calls.freeze.mockImplementation(async () => {
    calls.events.push("freeze");
    return { failedFrames: 0, failedWorkers: 0, dispose: calls.dispose };
  });
});

it.each([false, true])(
  "parks after priming/freezing and before authoritative pixels (entire page %s)",
  async (entirePage) => {
    let frames = 0;
    const page = {
      screenshot: async () => {
        calls.events.push(++frames === 1 ? "present" : "reference");
      },
    } as unknown as Page;
    await captureRealWorldReferenceFrame(page, {
      path: "expected.png",
      clip: { x: 0, y: 0, width: 80, height: 80 },
      entirePage,
      afterWebGlFreeze: async () => {
        calls.events.push("park");
      },
    });
    expect(calls.events).toEqual(
      entirePage ? ["present", "freeze", "park", "reference"] : ["present", "prime", "freeze", "park", "reference"],
    );
  },
);

it("does not publish a reference after the owner refuses the park", async () => {
  const screenshot = vi.fn().mockResolvedValue(undefined);
  await expect(
    captureRealWorldReferenceFrame({ screenshot } as unknown as Page, {
      path: "expected.png",
      clip: { x: 0, y: 0, width: 80, height: 80 },
      entirePage: false,
      afterWebGlFreeze: async () => {
        throw new Error("foreign clock");
      },
    }),
  ).rejects.toThrow("foreign clock");
  expect(screenshot).toHaveBeenCalledTimes(1);
  expect(calls.dispose).toHaveBeenCalledTimes(1);
});
