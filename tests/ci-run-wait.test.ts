import { describe, expect, it, vi } from "vitest";
import { waitForRunCompletion } from "../tools/ci-run-wait.mjs";

describe("waitForRunCompletion", () => {
  it("does not mistake a failed matrix job for a completed aggregate", async () => {
    const inspect = vi.fn()
      .mockResolvedValueOnce({ status: "in_progress", conclusion: "failure" })
      .mockResolvedValueOnce({ status: "queued", conclusion: "failure" })
      .mockResolvedValueOnce({ status: "completed", conclusion: "failure" });
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(waitForRunCompletion(inspect, { sleep, pollMs: 1, timeoutMs: 10_000 }))
      .resolves.toEqual({ status: "completed", conclusion: "failure" });
    expect(inspect).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("retries transient inspection errors", async () => {
    const inspect = vi.fn()
      .mockRejectedValueOnce(new Error("API unavailable"))
      .mockResolvedValueOnce({ status: "completed", conclusion: "success" });

    await expect(waitForRunCompletion(inspect, {
      sleep: vi.fn().mockResolvedValue(undefined), pollMs: 1, timeoutMs: 10_000,
    })).resolves.toMatchObject({ status: "completed" });
  });

  it("fails with the last observed status after the deadline", async () => {
    let now = 0;
    const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const sleep = vi.fn().mockImplementation(async () => { now += 50; });
    try {
      await expect(waitForRunCompletion(
        async () => ({ status: "queued", conclusion: "" }),
        { sleep, pollMs: 50, timeoutMs: 100 },
      )).rejects.toThrow("last status: queued");
    } finally {
      dateSpy.mockRestore();
    }
  });
});
