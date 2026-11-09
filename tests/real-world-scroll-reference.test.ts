import type { Frame, Page } from "@playwright/test";
import { afterEach, expect, it, vi } from "vitest";
const calls = vi.hoisted(() => ({ capture: vi.fn(), evaluate: vi.fn() }));
vi.mock("../src/capture/index.js", () => ({ captureElementTreeWithDebug: calls.capture }));
vi.mock("../src/capture/evaluate-in-frame.js", () => ({ evaluateInFrame: calls.evaluate }));
import { captureRealWorldScrollReference } from "./real-world-scroll-reference.js";

const viewport = { x: 0, y: 0, width: 320, height: 200 };
const page = { frames: () => [{} as Frame, {} as Frame] } as unknown as Page;
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

it("fails on the Node clock if any frame pause never settles, before capture publishes evidence", async () => {
  vi.useFakeTimers();
  calls.evaluate.mockResolvedValueOnce(undefined).mockImplementationOnce(() => new Promise<void>(() => {}));
  const pending = captureRealWorldScrollReference(page, "body", viewport);
  const rejected = expect(pending).rejects.toThrow("animation pause exceeded 2000ms");
  await vi.advanceTimersByTimeAsync(1999);
  expect(calls.capture).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await rejected;
  expect(calls.capture).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("propagates a pause failure and clears its Node deadline without capturing a partial frame", async () => {
  vi.useFakeTimers();
  calls.evaluate.mockRejectedValueOnce(new Error("frame pause failed")).mockResolvedValueOnce(undefined);
  await expect(captureRealWorldScrollReference(page, "body", viewport)).rejects.toThrow("frame pause failed");
  expect(calls.capture).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
