import type { BrowserContext, Page } from "@playwright/test";
import { afterEach, expect, it, vi } from "vitest";
import { registerCaptureFrameScheduler, waitForCaptureAnimationFrames } from "./frame-scheduler.js";

afterEach(() => vi.useRealTimers());

function target() {
  const context = {} as BrowserContext;
  const evaluate = vi.fn<(...args: unknown[]) => Promise<void>>();
  const page = { context: () => context, evaluate } as unknown as Page;
  return { context, evaluate, page };
}

it("bounds a stalled capture frame with the Node clock and invalidates later reference verification", async () => {
  vi.useFakeTimers();
  const { context, evaluate, page } = target();
  evaluate.mockImplementation(() => new Promise<void>(() => {}));
  const owner = registerCaptureFrameScheduler(context, "private-owner");
  owner.activate();
  try {
    const wait = waitForCaptureAnimationFrames(page, 2, 25);
    const rejected = expect(wait).rejects.toThrow("capture frame scheduler exceeded 25ms");
    await vi.advanceTimersByTimeAsync(24);
    expect(() => owner.assertValid()).not.toThrow();
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(() => owner.assertValid()).toThrow("capture frame scheduler failed");
    await expect(waitForCaptureAnimationFrames(page)).rejects.toThrow("capture frame scheduler failed");
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    owner.dispose();
  }
});

it("keeps an ownership rejection fatal even if a best-effort paint probe catches it", async () => {
  vi.useFakeTimers();
  const { context, evaluate, page } = target();
  evaluate.mockRejectedValue(new Error("foreign scheduler"));
  const owner = registerCaptureFrameScheduler(context, "private-owner");
  try {
    await waitForCaptureAnimationFrames(page, 1).catch(() => undefined);
    expect(() => owner.assertValid()).toThrow("foreign scheduler");
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    owner.dispose();
  }
});

it("does not share scheduler ownership across contexts", async () => {
  vi.useFakeTimers();
  const owned = target();
  const ordinary = target();
  ordinary.evaluate.mockResolvedValue(undefined);
  const owner = registerCaptureFrameScheduler(owned.context, "private-owner");
  try {
    owner.activate();
    await waitForCaptureAnimationFrames(ordinary.page, 1);
    expect(ordinary.evaluate).toHaveBeenCalledTimes(1);
    expect(owned.evaluate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    owner.dispose();
  }
});

it("cannot replace a registered owner or dispose a later registration with an old capability", () => {
  const { context } = target();
  const old = registerCaptureFrameScheduler(context, "first");
  expect(() => registerCaptureFrameScheduler(context, "foreign")).toThrow("already registered");
  old.dispose();
  const current = registerCaptureFrameScheduler(context, "second");
  try {
    old.dispose();
    current.activate();
    expect(() => registerCaptureFrameScheduler(context, "foreign")).toThrow("already registered");
  } finally {
    current.dispose();
  }
});
