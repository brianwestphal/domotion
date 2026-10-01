import { expect, it } from "vitest";
import type { Browser } from "@playwright/test";
import { withBrowser } from "../tools/lib/browser.mjs";

it("loads a document in real Chromium and closes after the probe", async () => {
  let browser: Browser | undefined;
  const title = await withBrowser(async (owned) => {
    browser = owned;
    const page = await owned.newPage();
    await page.setContent("<!doctype html><title>legacy probe</title>");
    return await page.title();
  });
  expect(title).toBe("legacy probe");
  expect(browser?.isConnected()).toBe(false);
});
