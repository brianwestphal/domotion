import { EventEmitter } from "node:events";
import type { CDPSession, JSHandle, Page } from "@playwright/test";
import { afterEach, expect, it, vi } from "vitest";
import {
  suppressDocumentVisibilityTransitions,
  type SnapshotVisibilityState,
} from "./snapshot-visibility-transitions.js";
import { openSnapshotShadowVisibilityGuard } from "./snapshot-shadow-visibility.js";

afterEach(() => vi.useRealTimers());
it("bounds preparation from Node and releases a late observation-only handle", async () => {
  vi.useFakeTimers();
  let finish!: (value: JSHandle<SnapshotVisibilityState>) => void;
  const late = new Promise<JSHandle<SnapshotVisibilityState>>((resolve) => {
    finish = resolve;
  });
  const evaluate = vi.fn();
  const page = { evaluateHandle: vi.fn(() => late), evaluate } as unknown as Page;
  const operation = suppressDocumentVisibilityTransitions(page);
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

it("bounds pierced-scope preparation and detaches a late CDP session without inspecting or changing the page", async () => {
  vi.useFakeTimers();
  let resolveSession!: (value: CDPSession) => void;
  const pending = new Promise<CDPSession>((resolve) => {
    resolveSession = resolve;
  });
  const frame = {};
  const page = Object.assign(new EventEmitter(), {
    frames: () => [frame],
    mainFrame: () => frame,
    context: () => ({ newCDPSession: () => pending }),
  });
  const operation = openSnapshotShadowVisibilityGuard(page as unknown as Page);
  const rejected = expect(operation).rejects.toThrow("author-shadow check exceeded 2000ms");
  await vi.advanceTimersByTimeAsync(2000);
  await rejected;
  expect(page.eventNames()).toEqual([]);
  const send = vi.fn();
  const detach = vi.fn().mockResolvedValue(undefined);
  resolveSession({ send, detach } as unknown as CDPSession);
  await Promise.resolve();
  expect(send).not.toHaveBeenCalled();
  expect(detach).toHaveBeenCalledOnce();
});
