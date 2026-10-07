import { chromium } from "@playwright/test";
import { describe, expect, it } from "vitest";
import {
  ChromeOracle,
  OracleStabilityGuard,
  probeOracleControlSignature,
  reassertPlaywrightMacFontFamilies,
} from "../tools/font-conformance.js";

describe("font conformance browser oracle stability", () => {
  it.skipIf(process.platform !== "darwin")(
    "replays preferences through the production oracle across batches",
    async () => {
      const browser = await chromium.launch({ headless: true });
      const oracle = await ChromeOracle.create(browser, 4, "en");
      try {
        const spec = { fontFamily: "serif", fontSize: 32, fontWeight: 400, fontStyle: "normal" };
        await oracle.assertStable("before stack");
        expect(await oracle.facesFor([0x41], spec)).toHaveLength(1);
        await oracle.assertStable("after primary");
        expect(await oracle.facesFor([0x42, 0x43], spec)).toHaveLength(2);
        await oracle.assertStable("after batch");
      } finally {
        await oracle.close();
        await browser.close();
      }
    },
    30_000,
  );

  it.skipIf(process.platform !== "darwin")(
    "can restore a changed Page preference from a fresh CDP session",
    async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent('<div style="font:32px serif">A</div>');
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("DOM.enable");
        await cdp.send("CSS.enable");
        const oracle = new ChromeOracle(page, cdp, 4, "en", true);
        await oracle.facesFor([0x41], { fontFamily: "serif", fontSize: 32, fontWeight: 400, fontStyle: "normal" });
        const initial = await probeOracleControlSignature(page, cdp);
        const defaults = await page.context().newCDPSession(page);
        await defaults.send("Page.setFontFamilies", {
          fontFamilies: {
            standard: "Times New Roman",
            serif: "Times New Roman",
            sansSerif: "Arial",
            fixed: "Menlo",
            cursive: "Times New Roman",
            fantasy: "Impact",
          },
        });
        const diagnostic = await oracle.diagnoseDrift();
        expect(diagnostic.beforeReplay).not.toEqual(initial);
        expect(diagnostic.afterReplay).toEqual(initial);
        expect(diagnostic.actualDocumentMarker).toBe(diagnostic.expectedDocumentMarker);
        expect(diagnostic.actualTimeOrigin).toBe(diagnostic.expectedTimeOrigin);
        expect(diagnostic.actualLoaderId).toBe(diagnostic.expectedLoaderId);
        expect(await probeOracleControlSignature(page, cdp)).toEqual(initial);
      } finally {
        await browser.close();
      }
    },
    30_000,
  );

  it.skipIf(process.platform !== "darwin")(
    "keeps ideograph fallback history through same-value Page preference replay",
    async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("DOM.enable");
        await cdp.send("CSS.enable");
        const oracle = new ChromeOracle(page, cdp, 4, "en", true);
        const spec = { fontFamily: "serif", fontSize: 32, fontWeight: 800, fontStyle: "normal" };
        await oracle.facesFor([0x3400], spec);
        const before = await oracle.facesFor([0x4e9f], spec);
        expect(before[0][0]?.postScriptName).toBe("STSongti-SC-Bold");
        await reassertPlaywrightMacFontFamilies(page);
        const after = await oracle.facesFor([0x4e9f], spec);
        expect(after).toEqual(before);
        const defaults = await page.context().newCDPSession(page);
        await defaults.send("Page.setFontFamilies", {
          fontFamilies: {
            standard: "Times New Roman",
            serif: "Times New Roman",
            sansSerif: "Arial",
            fixed: "Menlo",
            cursive: "Times New Roman",
            fantasy: "Impact",
          },
        });
        await reassertPlaywrightMacFontFamilies(page);
        const afterReset = await oracle.facesFor([0x4e9f], spec);
        expect(afterReset).toEqual(before);
      } finally {
        await browser.close();
      }
    },
    30_000,
  );

  it.skipIf(process.platform !== "darwin")(
    "repairs an idle Page setting reset before the next measured batch",
    async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("DOM.enable");
        await cdp.send("CSS.enable");
        const oracle = new ChromeOracle(page, cdp, 4, "en", true, reassertPlaywrightMacFontFamilies);
        const spec = { fontFamily: "serif", fontSize: 32, fontWeight: 800, fontStyle: "normal" };
        await oracle.prepareMeasurement("before stack");
        await oracle.facesFor([0x3400], spec);
        await oracle.assertStable("after first batch");
        const before = await oracle.facesFor([0x4e9f], spec);
        await oracle.assertStable("after second batch");
        expect(before[0][0]?.postScriptName).toBe("STSongti-SC-Bold");
        const defaults = await page.context().newCDPSession(page);
        await defaults.send("Page.setFontFamilies", {
          fontFamilies: {
            standard: "Times New Roman",
            serif: "Times New Roman",
            sansSerif: "Arial",
            fixed: "Menlo",
            cursive: "Times New Roman",
            fantasy: "Impact",
          },
        });
        await defaults.detach();
        const after = await oracle.facesFor([0x4e9f], spec);
        await oracle.assertStable("after repaired batch");
        expect(after).toEqual(before);
        expect(oracle.preferenceRepairEvents()).toHaveLength(1);
        expect(oracle.preferenceRepairEvents()[0].at).toContain("U+004E9F");
        const changedAgain = await page.context().newCDPSession(page);
        await changedAgain.send("Page.setFontFamilies", { fontFamilies: { serif: "Times New Roman" } });
        await changedAgain.detach();
        await expect(oracle.assertStable("after batch")).rejects.toThrow(/oracle font settings changed/);
      } finally {
        await browser.close();
      }
    },
    30_000,
  );

  it("keeps the measured document and generic donors while replacing batches and stack styles", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("DOM.enable");
      await cdp.send("CSS.enable");
      const oracle = new ChromeOracle(page, cdp, 4, "en", true);
      const serif = { fontFamily: "serif", fontSize: 32, fontWeight: 400, fontStyle: "normal" };
      const sans = { ...serif, fontFamily: "sans-serif", lang: "ja" };
      const first = await oracle.facesFor([0x41], serif);
      const donors = await probeOracleControlSignature(page, cdp);
      await page.evaluate(() => ((window as typeof window & { probeMarker?: string }).probeMarker = "same-document"));
      const second = await oracle.facesFor([0x42, 0x43], serif);
      expect(second).toHaveLength(2);
      expect(second[0]).toEqual(first[0]);
      await oracle.facesFor([], sans);
      const last = await oracle.facesFor([0x44], sans);
      expect(last).toHaveLength(1);
      expect(await page.locator("#w .c").count()).toBe(1);
      expect(await page.locator("#w .c").getAttribute("lang")).toBe("ja");
      expect(await page.locator("#w").evaluate((node) => getComputedStyle(node).fontFamily)).toBe("sans-serif");
      expect(await page.evaluate(() => (window as typeof window & { probeMarker?: string }).probeMarker)).toBe(
        "same-document",
      );
      expect(await probeOracleControlSignature(page, cdp)).toEqual(donors);

      // Apply a non-inert Page preference after the document exists, then
      // verify that cell replacement and a later stack change retain it.
      const serifFamily = first[0][0]?.familyName;
      const sansFamily = last[0][0]?.familyName;
      expect(serifFamily).toBeTruthy();
      expect(sansFamily).toBeTruthy();
      expect(serifFamily).not.toBe(sansFamily);
      await cdp.send("Page.setFontFamilies", {
        fontFamilies: { serif: sansFamily!, sansSerif: serifFamily! },
      });
      const changedDonors = await probeOracleControlSignature(page, cdp);
      expect(changedDonors).not.toEqual(donors);
      await oracle.facesFor([0x45, 0x46], serif);
      await oracle.facesFor([0x47], sans);
      expect(await probeOracleControlSignature(page, cdp)).toEqual(changedDonors);
      expect(await page.evaluate(() => (window as typeof window & { probeMarker?: string }).probeMarker)).toBe(
        "same-document",
      );
    } finally {
      await browser.close();
    }
  }, 30_000);

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

      const oracle = new ChromeOracle(page, cdp, 4, "en", true);
      const spec = { fontFamily: "serif", fontSize: 32, fontWeight: 400, fontStyle: "normal" };
      const serifFamily = (await oracle.facesFor([0x41], spec))[0][0]?.familyName;
      const sansFamily = (await oracle.facesFor([0x41], { ...spec, fontFamily: "sans-serif" }))[0][0]?.familyName;
      expect(serifFamily).toBeTruthy();
      expect(sansFamily).toBeTruthy();
      expect(serifFamily).not.toBe(sansFamily);
      await cdp.send("Page.setFontFamilies", { fontFamilies: { serif: sansFamily!, sansSerif: serifFamily! } });
      const changed = await probeOracleControlSignature(page, cdp);
      expect(changed).not.toEqual(initial);
      expect(() => guard.observe(changed)).toThrow(/oracle font settings changed during sweep/);
    } finally {
      await browser.close();
    }
  }, 30_000);
});
