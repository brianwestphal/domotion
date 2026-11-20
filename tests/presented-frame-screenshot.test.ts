import type { Page } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";
import { E2E_HOST_TRANSIENT_RETRY } from "./e2e-lanes.js";
import { SCREENSHOT_CAPTURE_FAILURE } from "./e2e-browser-evidence.js";
import {
  EMPTY_SURFACE_SCREENSHOT,
  EmptySurfaceScreenshotError,
  type EmptySurfaceAttempt,
  screenshotAfterPresentedFrame,
  waitForPresentedFrame,
} from "../src/test-support/presented-frame-screenshot.js";

// The first capture of a fresh hosted-runner browser can race the renderer's
// first compositor frame and get Chromium's empty-surface error
// (paint geometry browser oracle and mixed-locale shape-cache e2e failures).
const EMPTY = "page.screenshot: Protocol error (Page.captureScreenshot): Unable to capture screenshot";

type Outcome = Buffer | Error;

function fakePage(outcomes: Outcome[], frames: boolean[] = []) {
  const calls: string[] = [];
  const frameDeadlines: unknown[] = [];
  const screenshotOptions: unknown[] = [];
  const page = {
    evaluate: async (_fn: unknown, deadline: unknown) => {
      calls.push("frame");
      frameDeadlines.push(deadline);
      return frames.length ? frames.shift()! : true;
    },
    screenshot: async (options: unknown) => {
      calls.push("shot");
      screenshotOptions.push(options);
      const next = outcomes.shift();
      if (next == null) throw new Error("fake page has no more outcomes");
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return { page: page as unknown as Page, calls, frameDeadlines, screenshotOptions };
}

describe("screenshotAfterPresentedFrame", () => {
  it("waits for a presented frame before the first capture and passes options through", async () => {
    const png = Buffer.from("png");
    const onEmptySurface = vi.fn();
    const { page, calls, screenshotOptions, frameDeadlines } = fakePage([png]);
    await expect(screenshotAfterPresentedFrame(page, { omitBackground: true }, { onEmptySurface })).resolves.toBe(png);
    expect(calls).toEqual(["frame", "shot"]);
    expect(screenshotOptions).toEqual([{ omitBackground: true }]);
    expect(frameDeadlines).toEqual([5_000]);
    expect(onEmptySurface).not.toHaveBeenCalled();
  });

  it("defaults the screenshot options to an empty object", async () => {
    const { page, screenshotOptions } = fakePage([Buffer.from("png")]);
    await screenshotAfterPresentedFrame(page);
    expect(screenshotOptions).toEqual([{}]);
  });

  it("waits for a fresh frame before each retry of the empty-surface error and reports every empty copy", async () => {
    const png = Buffer.from("png");
    const reports: EmptySurfaceAttempt[] = [];
    const { page, calls } = fakePage([new Error(EMPTY), new Error(EMPTY), png], [false, true, true]);
    await expect(
      screenshotAfterPresentedFrame(page, {}, { onEmptySurface: (attempt) => reports.push(attempt) }),
    ).resolves.toBe(png);
    expect(calls).toEqual(["frame", "shot", "frame", "shot", "frame", "shot"]);
    expect(reports.map(({ attempt, presented, error }) => ({ attempt, presented, error }))).toEqual([
      { attempt: 1, presented: false, error: EMPTY },
      { attempt: 2, presented: true, error: EMPTY },
    ]);
    expect(reports.every((report) => report.waitMs >= 0)).toBe(true);
  });

  it("warns on the console by default so a recovered empty copy is still visible in CI logs", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { page } = fakePage([new Error(`${EMPTY}\nCall log:\n  - fonts loaded`), Buffer.from("png")]);
      await screenshotAfterPresentedFrame(page);
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0][0]);
      expect(line).toContain("empty surface copy on attempt 1 (presented=true");
      expect(line).toContain(EMPTY);
      expect(line).not.toContain("Call log");
    } finally {
      warn.mockRestore();
    }
  });

  it("does not retry any other screenshot error", async () => {
    const timeout = new Error("page.screenshot: Timeout 30000ms exceeded.");
    const onEmptySurface = vi.fn();
    const { page, calls } = fakePage([timeout, Buffer.from("never")]);
    await expect(screenshotAfterPresentedFrame(page, {}, { onEmptySurface })).rejects.toBe(timeout);
    expect(calls).toEqual(["frame", "shot"]);
    expect(onEmptySurface).not.toHaveBeenCalled();
  });

  it("does not retry a non-Error rejection", async () => {
    const page = {
      evaluate: async () => true,
      screenshot: async () => {
        throw "closed";
      },
    } as unknown as Page;
    await expect(screenshotAfterPresentedFrame(page, {}, { onEmptySurface: () => {} })).rejects.toBe("closed");
  });

  it("throws a typed error with every attempt's frame record after the bounded attempts", async () => {
    const { page, calls } = fakePage(
      [new Error(EMPTY), new Error(EMPTY), new Error(EMPTY), new Error(EMPTY), Buffer.from("late")],
      [true, false, true, true],
    );
    const error = await screenshotAfterPresentedFrame(page, {}, { onEmptySurface: () => {} }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmptySurfaceScreenshotError);
    const typed = error as EmptySurfaceScreenshotError;
    expect(calls.filter((call) => call === "shot")).toHaveLength(4);
    expect(typed.attempts.map((a) => [a.attempt, a.presented])).toEqual([
      [1, true],
      [2, false],
      [3, true],
      [4, true],
    ]);
    expect(typed.message).toContain("every one of 4 captures returned an empty surface copy");
    expect(typed.message).toContain("attempt 2: presented=false");
    expect((typed.cause as Error).message).toBe(EMPTY);
  });

  it("keeps the DevTools text so the E2E host-transient retry and evidence dump still match", async () => {
    const { page } = fakePage([new Error(EMPTY)]);
    const error = (await screenshotAfterPresentedFrame(page, {}, { attempts: 1, onEmptySurface: () => {} }).catch(
      (e: unknown) => e,
    )) as Error;
    expect(error.message).toMatch(EMPTY_SURFACE_SCREENSHOT);
    expect(error.message).toMatch(E2E_HOST_TRANSIENT_RETRY.condition);
    expect(error.message).toMatch(SCREENSHOT_CAPTURE_FAILURE);
  });

  it("honors attempts and frame-timeout policy, treating attempts below one as one", async () => {
    const one = fakePage([new Error(EMPTY), Buffer.from("never")]);
    await expect(
      screenshotAfterPresentedFrame(one.page, {}, { attempts: 0, onEmptySurface: () => {} }),
    ).rejects.toBeInstanceOf(EmptySurfaceScreenshotError);
    expect(one.calls).toEqual(["frame", "shot"]);

    const two = fakePage([new Error(EMPTY), Buffer.from("png")]);
    await screenshotAfterPresentedFrame(two.page, {}, { attempts: 2, frameTimeoutMs: 250, onEmptySurface: () => {} });
    expect(two.frameDeadlines).toEqual([250, 250]);
  });

  it("does not match other DevTools capture failures", () => {
    expect("Protocol error (Page.captureScreenshot): Cannot take screenshot with 0 width.").not.toMatch(
      EMPTY_SURFACE_SCREENSHOT,
    );
    expect("Unable to capture screenshot").not.toMatch(EMPTY_SURFACE_SCREENSHOT);
  });
});

describe("waitForPresentedFrame", () => {
  it("bounds the wait from Node when the page never answers (timers or rAF frozen)", async () => {
    const page = { evaluate: () => new Promise<boolean>(() => {}) } as unknown as Page;
    const result = await waitForPresentedFrame(page, 20);
    expect(result.presented).toBe(false);
    expect(result.waitMs).toBeGreaterThanOrEqual(15);
  });

  it("propagates an evaluation failure that arrives before the deadline", async () => {
    const closed = new Error("page.evaluate: Target page, context or browser has been closed");
    const page = { evaluate: () => Promise.reject(closed) } as unknown as Page;
    await expect(waitForPresentedFrame(page, 1_000)).rejects.toBe(closed);
  });

  it("ignores a late rejection from an evaluation that lost the race", async () => {
    let reject!: (error: Error) => void;
    const page = {
      evaluate: () => new Promise<boolean>((_resolve, rejectLater) => (reject = rejectLater)),
    } as unknown as Page;
    await expect(waitForPresentedFrame(page, 10)).resolves.toMatchObject({ presented: false });
    reject(new Error("closed after the deadline"));
    await new Promise((resolve) => setTimeout(resolve, 5));
  });

  it("reports whether frames ran and how long the wait took", async () => {
    const { page, frameDeadlines } = fakePage([], [false]);
    const result = await waitForPresentedFrame(page, 123);
    expect(result.presented).toBe(false);
    expect(result.waitMs).toBeGreaterThanOrEqual(0);
    expect(frameDeadlines).toEqual([123]);
  });
});
