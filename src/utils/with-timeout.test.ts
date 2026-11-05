import { afterEach, describe, expect, it, vi } from "vitest";
import { withTimeout } from "./with-timeout.js";

describe("withTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("settles with the promise and clears the deadline timer at once", async () => {
    vi.useFakeTimers();
    await expect(withTimeout(Promise.resolve("done"), 5_000)).resolves.toBe("done");
    // A bare Promise.race leaves the 5 s timer pending here, holding the event loop open.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settles with the fallback (undefined by default) once the deadline passes", async () => {
    vi.useFakeTimers();
    const never = new Promise<string>(() => {});
    const defaulted = withTimeout(never, 1_000);
    const explicit = withTimeout(never, 2_000, "late" as const);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(defaulted).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(explicit).resolves.toBe("late");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("propagates a rejection and still clears the timer", async () => {
    vi.useFakeTimers();
    await expect(withTimeout(Promise.reject(new Error("boom")), 5_000)).rejects.toThrow("boom");
    expect(vi.getTimerCount()).toBe(0);
  });
});
