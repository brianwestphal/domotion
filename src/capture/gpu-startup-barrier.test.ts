import { describe, expect, it, vi } from "vitest";
import { awaitGpuFeatureInfo } from "./gpu-startup-barrier.js";

type FakeSession = { send: ReturnType<typeof vi.fn>; detach: ReturnType<typeof vi.fn> };

function fakeBrowser(send: () => Promise<unknown>, detach: () => Promise<void> = () => Promise.resolve()) {
  const session: FakeSession = { send: vi.fn(send), detach: vi.fn(detach) };
  const browser = {
    newBrowserCDPSession: vi.fn(() => Promise.resolve(session)),
  } as unknown as Parameters<typeof awaitGpuFeatureInfo>[0];
  return { browser, session };
}

describe("awaitGpuFeatureInfo", () => {
  it("waits for SystemInfo.getInfo on the browser target, then detaches", async () => {
    let release: (() => void) | undefined;
    const { browser, session } = fakeBrowser(
      () =>
        new Promise((resolve) => {
          release = () => resolve({});
        }),
    );
    let settled = false;
    const result = awaitGpuFeatureInfo(browser, 1_000).then((value) => {
      settled = true;
      return value;
    });
    await vi.waitFor(() => expect(session.send).toHaveBeenCalledWith("SystemInfo.getInfo"));
    await Promise.resolve();
    expect(settled).toBe(false);
    release?.();
    await expect(result).resolves.toBe("ready");
    expect(session.detach).toHaveBeenCalledTimes(1);
  });

  it("gives up after the bound without throwing, and still detaches", async () => {
    const { browser, session } = fakeBrowser(() => new Promise(() => undefined));
    await expect(awaitGpuFeatureInfo(browser, 5)).resolves.toBe("timeout");
    expect(session.detach).toHaveBeenCalledTimes(1);
  });

  it("reports a rejected request or an unavailable session as unavailable", async () => {
    const rejected = fakeBrowser(() => Promise.reject(new Error("not supported")));
    await expect(awaitGpuFeatureInfo(rejected.browser, 1_000)).resolves.toBe("unavailable");
    expect(rejected.session.detach).toHaveBeenCalledTimes(1);

    const noSession = {
      newBrowserCDPSession: () => Promise.reject(new Error("closed")),
    } as unknown as Parameters<typeof awaitGpuFeatureInfo>[0];
    await expect(awaitGpuFeatureInfo(noSession, 1_000)).resolves.toBe("unavailable");
  });

  it("does not surface a failing detach", async () => {
    const { browser } = fakeBrowser(
      () => Promise.resolve({}),
      () => Promise.reject(new Error("already detached")),
    );
    await expect(awaitGpuFeatureInfo(browser, 1_000)).resolves.toBe("ready");
  });
});
