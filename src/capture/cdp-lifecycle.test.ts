import { describe, expect, it } from "vitest";
import type { CDPSession, Frame, Page } from "@playwright/test";
import { detachQuietly, disposeAll, isSameProcessFrameError, runPrepasses, withCdpSession } from "./cdp-lifecycle.js";

const ok = (log: string[], name: string) => ({
  dispose: async (): Promise<void> => {
    log.push(name);
  },
});
const failing = (log: string[], name: string, error: Error) => ({
  dispose: async (): Promise<void> => {
    log.push(name);
    throw error;
  },
});

describe("disposeAll", () => {
  it("runs every disposer in a healthy chain and skips undefined entries", async () => {
    const log: string[] = [];
    await disposeAll(ok(log, "a"), undefined, null, ok(log, "b"));
    expect(log.sort()).toEqual(["a", "b"]);
  });

  it("runs the LATER disposers even when an earlier one throws, then rethrows that error", async () => {
    const log: string[] = [];
    const boom = new Error("first");
    await expect(disposeAll(failing(log, "a", boom), ok(log, "b"), ok(log, "c"))).rejects.toBe(boom);
    expect(log.sort()).toEqual(["a", "b", "c"]);
  });

  it("reports several failures together instead of dropping all but one", async () => {
    const log: string[] = [];
    const one = new Error("one");
    const two = new Error("two");
    const error = await disposeAll(failing(log, "a", one), failing(log, "b", two)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([one, two]);
  });

  it("does not run a disposer twice and accepts an empty list", async () => {
    const log: string[] = [];
    const d = ok(log, "a");
    await disposeAll(d);
    await disposeAll();
    expect(log).toEqual(["a"]);
  });
});

describe("runPrepasses", () => {
  it("returns resources in declared order despite out-of-order completion", async () => {
    const events: string[] = [];
    const [first, second] = await runPrepasses([
      {
        prepare: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          events.push("first");
          return ok(events, "dispose first");
        },
      },
      { prepare: async () => (events.push("second"), ok(events, "dispose second")) },
    ] as const);
    expect(events).toEqual(["second", "first"]);
    await disposeAll(first, second);
    expect(events).toEqual(["second", "first", "dispose first", "dispose second"]);
  });

  it("waits for every prepare and cleans successes after one fails", async () => {
    const events: string[] = [];
    const failure = new Error("prepare failed");
    await expect(
      runPrepasses([
        { prepare: async () => ok(events, "early") },
        { prepare: async () => Promise.reject(failure) },
        { prepare: async () => (await Promise.resolve(), ok(events, "late")) },
      ] as const),
    ).rejects.toBe(failure);
    expect(events).toEqual(["early", "late"]);
  });

  it("preserves both the prepare and cleanup failures", async () => {
    const prepareFailure = new Error("prepare");
    const cleanupFailure = new Error("cleanup");
    const result = await runPrepasses([
      { prepare: async () => failing([], "cleanup", cleanupFailure) },
      { prepare: async () => Promise.reject(prepareFailure) },
    ] as const).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(AggregateError);
    expect((result as AggregateError).errors).toEqual([prepareFailure, cleanupFailure]);
  });
});

describe("detachQuietly", () => {
  it("swallows a detach rejection so it cannot mask the error being handled", async () => {
    await expect(detachQuietly({ detach: () => Promise.reject(new Error("closed")) })).resolves.toBeUndefined();
    await expect(detachQuietly(undefined)).resolves.toBeUndefined();
    await expect(detachQuietly(null)).resolves.toBeUndefined();
  });

  it("still detaches a healthy session", async () => {
    let detached = false;
    await detachQuietly({
      detach: async () => {
        detached = true;
      },
    });
    expect(detached).toBe(true);
  });
});

describe("isSameProcessFrameError", () => {
  it("recognizes Playwright's same-process-frame refusal and nothing else", () => {
    expect(
      isSameProcessFrameError(new Error("Frame was not found: This frame is part of the parent frame's session")),
    ).toBe(true);
    expect(isSameProcessFrameError(new Error("This frame does not have a separate CDP session"))).toBe(true);
    expect(isSameProcessFrameError(new Error("Target closed"))).toBe(false);
    expect(isSameProcessFrameError(undefined)).toBe(false);
  });
});

describe("withCdpSession", () => {
  it("detaches after success and after a work failure without replacing that failure", async () => {
    const events: string[] = [];
    const session = {
      detach: async () => {
        events.push("detach");
        throw new Error("closed");
      },
    } as unknown as CDPSession;
    const page = { context: () => ({ newCDPSession: async () => session }) } as unknown as Page;
    expect(
      await withCdpSession(page, async () => {
        events.push("work");
        return 7;
      }),
    ).toBe(7);
    const failure = new Error("work failed");
    await expect(
      withCdpSession(page, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(events).toEqual(["work", "detach", "detach"]);
  });

  it("uses an explicit fallback only for a same-process child frame", async () => {
    const page = {
      context: () => ({
        newCDPSession: async () => {
          throw new Error("part of the parent frame's session");
        },
      }),
    } as unknown as Page;
    const frame = { page: () => page } as unknown as Frame;
    expect(await withCdpSession(frame, async () => 1, { sameProcessFrame: () => 2 })).toBe(2);
    await expect(withCdpSession(frame, async () => 1)).rejects.toThrow("parent frame's session");
    await expect(withCdpSession(page, async () => 1, { sameProcessFrame: () => 2 })).rejects.toThrow(
      "parent frame's session",
    );
  });
});
