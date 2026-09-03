import { describe, expect, it, vi } from "vitest";
import { closeTimedOutCaptureContext } from "./real-world-timeout.js";

describe("real-world capture timeout", () => {
  it("quiesces active HAR routes before closing their context", async () => {
    const calls: string[] = [];
    const context = {
      unrouteAll: vi.fn(async (options: { behavior?: string }) => {
        calls.push(`unroute:${options.behavior}`);
      }),
      close: vi.fn(async (options?: { reason?: string }) => {
        calls.push(`close:${options?.reason}`);
      }),
    };

    await closeTimedOutCaptureContext(context, "capture exceeded 6m");

    expect(calls).toEqual([
      "unroute:ignoreErrors",
      "close:capture exceeded 6m",
    ]);
  });

  it("still closes when route cleanup itself rejects", async () => {
    const close = vi.fn(async () => {});
    await closeTimedOutCaptureContext({
      unrouteAll: vi.fn(async () => { throw new Error("already closed"); }),
      close,
    }, "timed out");

    expect(close).toHaveBeenCalledOnce();
  });
});
