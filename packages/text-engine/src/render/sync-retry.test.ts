import { describe, expect, it } from "vitest";
import { isTransientFsError, retrySync } from "./sync-retry.js";

describe("retrySync", () => {
  it("returns the first success without waiting", () => {
    let calls = 0;
    expect(retrySync(() => ++calls)).toBe(1);
  });

  it("retries until success within the budget", () => {
    let calls = 0;
    const value = retrySync(
      () => {
        if (++calls < 3) throw new Error("busy");
        return "ok";
      },
      { baseMs: 1 },
    );
    expect([value, calls]).toEqual(["ok", 3]);
  });

  it("rethrows the LAST error after exactly `attempts` tries", () => {
    let calls = 0;
    expect(() =>
      retrySync(
        () => {
          throw new Error(`fail ${++calls}`);
        },
        { attempts: 4, baseMs: 1 },
      ),
    ).toThrow("fail 4");
    expect(calls).toBe(4);
  });

  it("stops at once when shouldRetry rejects the error", () => {
    let calls = 0;
    expect(() =>
      retrySync(
        () => {
          calls++;
          throw Object.assign(new Error("gone"), { code: "ENOENT" });
        },
        { shouldRetry: isTransientFsError, baseMs: 1 },
      ),
    ).toThrow("gone");
    expect(calls).toBe(1);
  });

  it("keeps retrying transient fs codes and treats non-errors as non-transient", () => {
    expect(isTransientFsError(Object.assign(new Error(), { code: "EMFILE" }))).toBe(true);
    expect(isTransientFsError(Object.assign(new Error(), { code: "ENFILE" }))).toBe(true);
    expect(isTransientFsError(Object.assign(new Error(), { code: "EAGAIN" }))).toBe(true);
    expect(isTransientFsError(Object.assign(new Error(), { code: "ENOENT" }))).toBe(false);
    expect(isTransientFsError(null)).toBe(false);
    expect(isTransientFsError("x")).toBe(false);
  });
});
