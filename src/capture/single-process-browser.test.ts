import type { Page } from "@playwright/test";
import { describe, expect, it } from "vitest";
import { browserRunsSingleProcess } from "./single-process-browser.js";

/** One fake browser shared by every page built from it, so the per-Browser cache is observable. */
function fakeBrowser(answers: Array<() => Promise<{ arguments: string[] }>>) {
  const browser = {};
  let asked = 0;
  const pageFor = () =>
    ({
      context: () => ({
        browser: () => browser,
        newCDPSession: async () => ({
          send: async () => answers[Math.min(asked++, answers.length - 1)]!(),
          detach: async () => {},
        }),
      }),
    }) as unknown as Page;
  return { pageFor, asked: () => asked };
}

describe("browserRunsSingleProcess", () => {
  it("reads --single-process from the browser command line and caches the answer per Browser", async () => {
    const { pageFor, asked } = fakeBrowser([async () => ({ arguments: ["/shell", "--single-process"] })]);
    expect(await browserRunsSingleProcess(pageFor())).toBe(true);
    expect(await browserRunsSingleProcess(pageFor())).toBe(true);
    expect(asked()).toBe(1);
  });

  it("answers false for a multi-process command line", async () => {
    const { pageFor } = fakeBrowser([async () => ({ arguments: ["/shell", "--headless"] })]);
    expect(await browserRunsSingleProcess(pageFor())).toBe(false);
  });

  it("answers unknown for a withheld (empty) command line", async () => {
    const { pageFor } = fakeBrowser([async () => ({ arguments: [] })]);
    expect(await browserRunsSingleProcess(pageFor())).toBeUndefined();
  });

  it("does not cache a failed query: a later caller asks again", async () => {
    const { pageFor, asked } = fakeBrowser([
      async () => {
        throw new Error("transient CDP failure");
      },
      async () => ({ arguments: ["/shell", "--single-process"] }),
    ]);
    expect(await browserRunsSingleProcess(pageFor())).toBeUndefined();
    expect(await browserRunsSingleProcess(pageFor())).toBe(true);
    expect(asked()).toBe(2);
  });

  it("answers unknown for a page with no owning Browser", async () => {
    const page = { context: () => ({ browser: () => null }) } as unknown as Page;
    expect(await browserRunsSingleProcess(page)).toBeUndefined();
  });
});
