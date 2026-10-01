import { chromium } from "@playwright/test";
import { afterAll, expect, it } from "vitest";
import { evaluateInFrame } from "../src/capture/evaluate-in-frame.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

const browser = await chromium.launch();
afterAll(async () => closeBrowserSafely(browser), 15_000);

it("runs source callbacks with a lexical name helper and preserves authored page globals", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent("<div id='answer'>7</div>");
    const before = await page.evaluate(() => Object.prototype.hasOwnProperty.call(globalThis, "__name"));
    expect(before).toBe(false);
    const value = await evaluateInFrame(
      page.mainFrame(),
      ({ increment }) => {
        const read = () => Number(document.querySelector("#answer")?.textContent);
        return read() + increment;
      },
      { increment: 5 },
    );
    expect(value).toBe(12);
    expect(await page.evaluate(() => Object.prototype.hasOwnProperty.call(globalThis, "__name"))).toBe(false);

    await page.evaluate(() => {
      (globalThis as typeof globalThis & { __name?: string }).__name = "author";
    });
    expect(await evaluateInFrame(page, () => document.querySelector("#answer")?.textContent)).toBe("7");
    expect(await page.evaluate(() => (globalThis as typeof globalThis & { __name?: string }).__name)).toBe("author");
  } finally {
    await page.close();
  }
});
