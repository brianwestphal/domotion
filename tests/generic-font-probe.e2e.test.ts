import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext } from "@playwright/test";
import { probeSessionGenericFamilies } from "../src/capture/generic-font-probe.js";

describe("the live session generic-family probe", () => {
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;

  beforeAll(async () => {
    browser = await chromium.launch();
    context = await browser.newContext();
  });

  afterAll(async () => {
    await context?.close();
    await browser?.close();
  });

  it("returns stable Common and per-script painted-family answers", async () => {
    const result = await probeSessionGenericFamilies(context!);
    expect(result).not.toBeNull();
    expect([...result!.common.keys()]).toEqual([
      "serif", "sans-serif", "monospace", "cursive", "fantasy", "math",
    ]);
    for (const script of [
      "KATAKANA_OR_HIRAGANA", "HANGUL", "SIMPLIFIED_HAN", "TRADITIONAL_HAN",
    ]) {
      expect([...result!.byScript.get(script)!.keys()])
        .toEqual(["serif", "sans-serif", "monospace"]);
    }
  });
});
