#!/usr/bin/env npx tsx
/** Same-machine system-ui family/cut assertion for DM-2087. */
import { chromium } from "@playwright/test";
import { clearFontResolutionCaches, resolveFont, resolveFontKey } from "../src/render/font-resolution.js";

if (process.platform !== "linux") process.exit(0);

const norm = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, "");
const cases = [
  { weight: 400, style: "normal", stretch: "normal" },
  { weight: 700, style: "normal", stretch: "normal" },
  { weight: 400, style: "italic", stretch: "normal" },
  { weight: 400, style: "normal", stretch: "condensed" },
] as const;

const browser = await chromium.launch();
try {
  for (const fresh of [false, true]) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    for (const [index, c] of cases.entries()) {
      await page.setContent(`<span id="probe" lang="${index % 2 ? "ja" : "en"}" style="font: ${c.style} ${c.weight} ${c.stretch} 24px system-ui, sans-serif">Hamburgefons</span>`);
      const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
      const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#probe" });
      const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
      const chrome = fonts.find((font) => font.glyphCount > 0)?.familyName;
      clearFontResolutionCaches();
      const key = resolveFontKey("system-ui, sans-serif");
      const ours = resolveFont("system-ui, sans-serif", c.weight, 24, c.style === "italic" ? 12 : 0, undefined, c.stretch === "condensed" ? 75 : 100, index % 2 ? "ja" : "en") as { postscriptName?: string; familyName?: string } | null;
      const oursName = ours?.familyName ?? ours?.postscriptName;
      if (chrome == null || key == null || oursName == null || !norm(oursName).startsWith(norm(chrome))) {
        throw new Error(`${JSON.stringify(c)} Chromium=${chrome ?? "none"}, Domotion=${oursName ?? key ?? "none"}`);
      }
      console.log(`${fresh ? "fresh" : "warm"} ${JSON.stringify(c)} -> Chromium ${chrome}; Domotion ${oursName}`);
    }
    await context.close();
  }
} finally {
  await browser.close();
}
