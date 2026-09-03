import { afterAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "@playwright/test";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import { closeTimedOutCaptureContext } from "./real-world-timeout.js";

let browser: Browser | null = null;
try { browser = await chromium.launch(); } catch { /* browserless host */ }
afterAll(async () => closeBrowserSafely(browser), 15_000);

(browser == null ? describe.skip : describe)("real-world HAR timeout teardown", () => {
  it("suppresses an in-flight route callback before closing the context", async () => {
    const context = await browser!.newContext();
    const page = await context.newPage();
    let entered!: () => void;
    let release!: () => void;
    const handlerEntered = new Promise<void>((resolve) => { entered = resolve; });
    const handlerRelease = new Promise<void>((resolve) => { release = resolve; });
    await context.route("https://timeout.invalid/**", async (route) => {
      entered();
      await handlerRelease;
      await route.continue();
    });

    const navigation = page.goto("https://timeout.invalid/fixture").catch(() => null);
    await handlerEntered;
    await closeTimedOutCaptureContext(context, "fixture watchdog elapsed");
    release();
    await navigation;

    expect(context.pages()).toHaveLength(0);
  });
});
