import { describe, expect, it } from "vitest";
import { createCompareLock } from "./html-test/compare-lock.js";

describe("shared comparison page lock", () => {
  it("rejects calls before the page is initialized", async () => {
    const lock = createCompareLock<{ name: string }>();
    await expect(lock.withCompareLock(async () => 1)).rejects.toThrow(/before sharedComparePage/);
  });

  it("serializes interleaved calls and releases after a throw", async () => {
    const lock = createCompareLock<{ name: string }>();
    lock.setPage({ name: "compare" });
    const order: string[] = [];
    let unblock!: () => void;
    const barrier = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const first = lock.withCompareLock(async (page) => {
      order.push(`start:${page.name}`);
      await barrier;
      order.push("throw");
      throw new Error("comparison failed");
    });
    const second = lock.withCompareLock(async () => {
      order.push("second");
      return 2;
    });
    const third = lock.withCompareLock(async () => {
      order.push("third");
      return 3;
    });
    await Promise.resolve();
    expect(order).toEqual(["start:compare"]);
    unblock();
    await expect(first).rejects.toThrow("comparison failed");
    expect(await second).toBe(2);
    expect(await third).toBe(3);
    expect(order).toEqual(["start:compare", "throw", "second", "third"]);
  });
});
