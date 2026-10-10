import { chromium } from "@playwright/test";
import { describe, expect, it } from "vitest";
import {
  assertSupplementaryPuaOracleFace,
  chromeFaceCoversCodepoint,
  primaryChromeFace,
  probePageHtml,
  type ChromeFace,
  type OurFace,
  type StackSpec,
} from "../tools/font-conformance.js";

describe("macOS supplementary PUA oracle sentinel", () => {
  it.skipIf(process.platform !== "darwin")("checks the reported cut inside a native TTC", () => {
    const regular: ChromeFace = {
      familyName: "Hiragino Mincho ProN",
      postScriptName: "HiraMinProN-W3",
      glyphCount: 1,
    };
    const bold: ChromeFace = { ...regular, postScriptName: "HiraMinProN-W6" };
    for (const face of [regular, bold]) {
      expect(chromeFaceCoversCodepoint(face, 0x41)).toBe(true);
      expect(chromeFaceCoversCodepoint(face, 0x560)).toBe(false);
    }
  });

  it.skipIf(process.platform !== "darwin")(
    "detects a same-page generic fallback change in natural ask order",
    async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("DOM.enable");
        await cdp.send("CSS.enable");
        const spec: StackSpec = { fontFamily: "sans-serif", fontSize: 32, fontWeight: 700, fontStyle: "normal" };
        const tofu: OurFace = { key: "sysfb:Helvetica", path: null, postscriptName: "Helvetica-Bold", covered: false };
        const ask = async (cp: number): Promise<ChromeFace[]> => {
          await page.setContent(probePageHtml([cp], spec, "en"));
          const { root } = await cdp.send("DOM.getDocument");
          const { nodeIds } = await cdp.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: ".c" });
          expect(nodeIds).toHaveLength(1);
          const result = await cdp.send("CSS.getPlatformFontsForNode", { nodeId: nodeIds[0] });
          return result.fonts as ChromeFace[];
        };

        const primary = primaryChromeFace(await ask(0x41))?.postScriptName ?? null;
        expect(primary).not.toBeNull();
        assertSupplementaryPuaOracleFace(spec, 0x100000, await ask(0x100000), tofu, primary, "initial", "darwin");

        await cdp.send("Page.setFontFamilies", { fontFamilies: { sansSerif: "Arial" } });
        const changed = await ask(0x10130c);
        expect(primaryChromeFace(changed)?.postScriptName).toBe("Arial-BoldMT");
        expect(() =>
          assertSupplementaryPuaOracleFace(spec, 0x10130c, changed, tofu, primary, "changed", "darwin"),
        ).toThrow(/supplementary PUA face diverged/);
      } finally {
        await browser.close();
      }
    },
    30_000,
  );
});
