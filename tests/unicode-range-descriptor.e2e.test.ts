import type { Browser } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchChromium } from "../src/index.js";
import { parseUnicodeRangeDescriptor } from "../src/capture/unicode-range.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// DM-KRMZ4Y: Domotion's `unicode-range` parser must accept exactly the
// descriptors Chromium's CSS parser accepts, with the same intervals. Chromium
// is the oracle here: an `@font-face` rule whose descriptor fails to parse
// drops it (CSSOM reads ""), and an accepted one serializes as a normalized
// `U+%X[-%X]` list. Parsing that serialization gives Chromium's intervals.

const CORPUS = [
  "U+26",
  "u+0-7f",
  "U+0000-00FF, U+0131, U+0152-0153",
  "U+4??",
  "u+??",
  "U+10FFFF",
  "U+0-10FFFF",
  "  U+0-7F ,\n\tU+100 /* comment */ , U+2??  ",
  "U+41zz",
  "u+cake",
  "u+12345678",
  "u+123-12345678",
  "U+ab12???",
  "u+a1?-123",
  "u+1??4",
  "u+222-111",
  "U+7F-0",
  "U+110000",
  "u+??????",
  "U+0-110000",
  "u+012345-123456",
  "U+0-7F, U+41zz",
  "U+0-7F,,U+100",
  "U+0-7F,",
  ",U+0-7F",
  "U+41 U+42",
  "U+0-",
  "u+z",
  "U +41",
  "41",
];

let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(async () => {
  await closeBrowserSafely(browser);
});

describe("unicode-range descriptor parity with Chromium (DM-KRMZ4Y)", () => {
  it("accepts and rejects the same descriptors, with the same intervals", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent("<!doctype html><html><head></head><body></body></html>");
      const chromium = await page.evaluate((values) => {
        return values.map((value) => {
          const style = document.createElement("style");
          style.textContent = `@font-face { font-family: probe; src: url(probe.woff2); unicode-range: ${value}; }`;
          document.head.appendChild(style);
          const rule = style.sheet?.cssRules[0] as CSSFontFaceRule | undefined;
          const serialized = rule?.style.getPropertyValue("unicode-range") ?? "";
          style.remove();
          return serialized;
        });
      }, CORPUS);
      const mismatches = CORPUS.flatMap((value, i) => {
        const expected = chromium[i] === "" ? undefined : parseUnicodeRangeDescriptor(chromium[i]);
        if (chromium[i] !== "") expect(expected, `Chromium serialization ${chromium[i]}`).toBeDefined();
        const actual = parseUnicodeRangeDescriptor(value);
        return JSON.stringify(actual) === JSON.stringify(expected)
          ? []
          : [{ value, chromium: chromium[i], expected, actual }];
      });
      expect(mismatches).toEqual([]);
      // The corpus must exercise both verdicts, or it cannot discriminate.
      expect(chromium.filter((s) => s === "").length).toBeGreaterThan(5);
      expect(chromium.filter((s) => s !== "").length).toBeGreaterThan(5);
    } finally {
      await page.close();
    }
  });
});
