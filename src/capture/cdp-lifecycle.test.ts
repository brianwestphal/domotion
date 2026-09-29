import { describe, expect, it } from "vitest";
import { detachQuietly, disposeAll, isSameProcessFrameError } from "./cdp-lifecycle.js";

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
    expect(isSameProcessFrameError(new Error("Target closed"))).toBe(false);
    expect(isSameProcessFrameError(undefined)).toBe(false);
  });
});
