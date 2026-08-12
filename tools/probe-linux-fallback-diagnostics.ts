#!/usr/bin/env npx tsx
/** DM-2086: pair Fontconfig construction diagnostics with Chrome-observable paint. */
import { chromium } from "@playwright/test";
import { resolveFcFallbackDiagnostic } from "../src/render/glyph-helper.js";

const cases = [
  { cp: 0x0600, lang: "ko" }, { cp: 0x0700, lang: "ko" },
  { cp: 0x2200, lang: "ar" }, { cp: 0x2600, lang: "ja" },
];
if (process.platform !== "linux") process.exit(0);
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
  const rows = [];
  for (const c of cases) {
    await page.setContent(`<span id="p" lang="${c.lang}" style="font:32px sans-serif">${String.fromCodePoint(c.cp)}</span>`);
    const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#p" });
    const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
    const diagnostic = resolveFcFallbackDiagnostic([c.cp], c.lang);
    if (diagnostic == null) throw new Error("Linux helper does not support fcdiagnostic");
    rows.push({ ...c, chromium: fonts.filter((f) => f.glyphCount > 0), diagnostic });
  }
  console.log(JSON.stringify({ chromium: await browser.version(), rows }, null, 2));
} finally {
  await browser.close();
}
