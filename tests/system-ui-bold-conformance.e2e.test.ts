import { describe, expect, it } from "vitest";
import { chromium } from "@playwright/test";
import { isGlyphHelperAvailable } from "@domotion/text-engine/testing";
import { faceFor, prepareStack, type StackSpec } from "../tools/font-conformance.js";

const describeMac = process.platform === "darwin" ? describe : describe.skip;
const FAMILY = "system-ui, -apple-system, sans-serif";
const WEIGHTS = [400, 600, 700, 800, 700, 400] as const;

describeMac("macOS system-ui face identity against Chromium", () => {
  it("keeps regular, boundary, bold, and repeated font choices aligned with the real browser", async () => {
    expect(isGlyphHelperAvailable()).toBe(true);
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(
        `<style>.cell{display:inline-block;font-family:${FAMILY};font-size:20px}</style>` +
          WEIGHTS.map((weight) => `<span class="cell" style="font-weight:${weight}">A</span>`).join(""),
      );
      await page
        .locator(".cell")
        .first()
        .evaluate((element) => element.getBoundingClientRect());
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("DOM.enable");
      await cdp.send("CSS.enable");
      const { root } = await cdp.send("DOM.getDocument");
      const { nodeIds } = await cdp.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: ".cell" });
      expect(nodeIds).toHaveLength(WEIGHTS.length);

      for (let i = 0; i < WEIGHTS.length; i++) {
        const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId: nodeIds[i] });
        const spec: StackSpec = {
          fontFamily: FAMILY,
          fontWeight: WEIGHTS[i],
          fontSize: 20,
          fontStyle: "normal",
          fixtures: 1,
          example: "system-ui-bold-conformance.e2e.test.ts",
        };
        const run = prepareStack(spec);
        expect(run).not.toBeNull();
        const ours = faceFor(run!, run!.primaryKey, true, null);
        expect(fonts[0]?.postScriptName, `Chromium weight ${WEIGHTS[i]}`).toBeTruthy();
        expect(ours.postscriptName, `weight ${WEIGHTS[i]}`).toBe(fonts[0]?.postScriptName);
        const axes = (run!.primary as { _appliedVariationAxes?: Record<string, number> })._appliedVariationAxes;
        expect(axes?.wght).toBe(WEIGHTS[i]);
      }
    } finally {
      await browser.close();
    }
  }, 30_000);
});
