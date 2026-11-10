import type { JSHandle, Page } from "@playwright/test";
import { afterEach, expect, it, vi } from "vitest";
import {
  suppressSnapshotVisibilityTransitions,
  type SnapshotVisibilityState,
} from "./snapshot-visibility-transitions.js";
afterEach(() => vi.useRealTimers());
it("bounds preparation from Node and releases a late observation-only handle", async () => {
  vi.useFakeTimers();
  let finish!: (value: JSHandle<SnapshotVisibilityState>) => void;
  const late = new Promise<JSHandle<SnapshotVisibilityState>>((resolve) => {
    finish = resolve;
  });
  const evaluate = vi.fn();
  const page = { evaluateHandle: vi.fn(() => late), evaluate } as unknown as Page;
  const operation = suppressSnapshotVisibilityTransitions(page);
  const rejected = expect(operation).rejects.toThrow("operation exceeded 2000ms");
  await vi.advanceTimersByTimeAsync(2000);
  await rejected;
  expect(evaluate).not.toHaveBeenCalled();
  const dispose = vi.fn().mockResolvedValue(undefined);
  finish({ dispose } as unknown as JSHandle<SnapshotVisibilityState>);
  await Promise.resolve();
  await Promise.resolve();
  expect(dispose).toHaveBeenCalledOnce();
});
