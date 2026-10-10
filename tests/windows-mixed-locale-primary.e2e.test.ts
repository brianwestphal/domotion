import { chromium } from "@playwright/test";
import { isGlyphHelperAvailable, setSessionGenericFamilyOverrides } from "@domotion/text-engine/testing";
import { describe, expect, it } from "vitest";
import { probeSessionGenericFamilies } from "../src/capture/generic-font-probe.js";
import { ChromeOracle, ourFaceFor, prepareStack, type StackSpec } from "../tools/font-conformance.js";

const describeWindows = process.platform === "win32" && isGlyphHelperAvailable() ? describe : describe.skip;

const japanese: StackSpec = {
  fontFamily: "serif",
  fontSize: 16,
  fontWeight: 400,
  fontStyle: "normal",
  fontStretch: "100%",
  lang: "ja",
};
const english: StackSpec = { ...japanese, fontStretch: "150%", lang: "en" };

describeWindows("Windows mixed-locale primary in one document", () => {
  it("resolves the English face after a Japanese face was shaped", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext();
      const generics = await probeSessionGenericFamilies(context);
      expect(generics).not.toBeNull();
      setSessionGenericFamilyOverrides(generics!);
      const page = await context.newPage();
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("DOM.enable");
      await cdp.send("CSS.enable");
      await page.setContent(
        '<!doctype html><html lang="en"><style>' +
          "i{display:inline-block;font-family:serif;font-size:16px;font-weight:400;font-style:normal}" +
          "#en{font-stretch:150%}" +
          '</style><body><i id="ja" lang="ja">A</i></body></html>',
      );
      const usedFace = async (selector: string) => {
        // A node appended to a live document can be in the DOM before Blink
        // has assigned its painted font. CDP reports [] in that interval.
        // Wait for two animation frames after forcing layout so the assertion
        // observes the same painted-face state as the conformance oracle.
        await page.locator(selector).evaluate(async (element) => {
          await document.fonts.ready;
          element.getBoundingClientRect();
          await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        });
        const { root } = await cdp.send("DOM.getDocument");
        const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
        const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
        expect(fonts).toHaveLength(1);
        return fonts[0].postScriptName ?? fonts[0].familyName;
      };
      const chromeJapanese = await usedFace("#ja");
      await page.evaluate(() => {
        const element = document.createElement("i");
        element.id = "en";
        element.lang = "en";
        element.textContent = "A";
        document.body.append(element);
      });
      const chromeEnglish = await usedFace("#en");
      const isolatedOracle = await ChromeOracle.create(browser, 16, "en");
      let isolatedEnglish: string | null;
      try {
        isolatedEnglish = await isolatedOracle.resolvedPrimary(english);
      } finally {
        await isolatedOracle.close();
      }

      const japaneseStack = prepareStack(japanese, "en");
      const englishStack = prepareStack(english, "en");
      expect(japaneseStack).not.toBeNull();
      expect(englishStack).not.toBeNull();
      const ourJapanese = ourFaceFor(0x41, japaneseStack!, "ja").postscriptName;
      const ourEnglish = ourFaceFor(0x41, englishStack!, "en").postscriptName;
      expect(chromeJapanese).not.toBe(isolatedEnglish);
      expect(chromeEnglish).toBe(isolatedEnglish);
      expect(chromeJapanese).toBe(ourJapanese);
      expect(chromeEnglish).toBe(ourEnglish);
    } finally {
      await browser.close();
    }
  }, 60_000);
});
