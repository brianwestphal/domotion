import { chromium } from "@playwright/test";
import { describe, expect, it } from "vitest";
import { OracleStabilityGuard, probeOracleControlSignature } from "../tools/font-conformance.js";

describe("font conformance browser oracle stability", () => {
  it("keeps Japanese generic donor controls stable across the first measured document", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("DOM.enable");
      await cdp.send("CSS.enable");
      const guard = new OracleStabilityGuard();
      const before = await probeOracleControlSignature(page, cdp, "ja");
      guard.observe(before);
      await page.setContent('<html lang="ja"><body><span>日本語</span></body></html>');
      const after = await probeOracleControlSignature(page, cdp, "ja");
      expect(after).toEqual(before);
      expect(() => guard.observe(after)).not.toThrow();
    } finally {
      await browser.close();
    }
  }, 30_000);

  it("detects a generic-family settings change on the same Chromium page", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("DOM.enable");
      await cdp.send("CSS.enable");
      await page.setContent('<div id="measured-batch">measured content</div>');
      await page.evaluate(
        () => ((window as typeof window & { oracleDocumentMarker?: object }).oracleDocumentMarker = {}),
      );
      const guard = new OracleStabilityGuard();
      const initial = await probeOracleControlSignature(page, cdp);
      guard.observe(initial);
      guard.observe(await probeOracleControlSignature(page, cdp));
      expect(await page.locator("#measured-batch").textContent()).toBe("measured content");
      expect(
        await page.evaluate(() =>
          Boolean((window as typeof window & { oracleDocumentMarker?: object }).oracleDocumentMarker),
        ),
      ).toBe(true);
      expect(await page.locator("#font-conformance-oracle-controls").count()).toBe(0);

      await cdp.send("Page.setFontFamilies", {
        fontFamilies: {
          standard: "Times New Roman",
          serif: "Times New Roman",
          sansSerif: "Arial",
          fixed: "Menlo",
          cursive: "Script",
          fantasy: "Impact",
        },
      });
      const changed = await probeOracleControlSignature(page, cdp);
      expect(changed).not.toEqual(initial);
      expect(() => guard.observe(changed)).toThrow(/oracle font settings changed during sweep/);
    } finally {
      await browser.close();
    }
  }, 30_000);
});
