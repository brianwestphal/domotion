import { afterAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "@playwright/test";
import { launchChromium, captureElementTree } from "../src/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// A Page's generic font families come from Playwright's per-page
// `Page.setFontFamilies` overlay, laid over Chromium's WebPreferences. Any
// browser-side WebPreferences push re-applies the WebPreferences maps and
// replaces that overlay: `Page.captureScreenshot` with `captureBeyondViewport`
// installs modified preferences and then restores the original ones
// (content/browser/devtools/protocol/page_handler.cc:1499-1512, 1826-1829,
// chromium 7d859f27), and `WebSettingsImpl::Set*FontFamily` notifies a
// generic-family change. These tests pin two properties: capture itself never
// triggers that reset, and after a reset the captured record follows what
// Chrome now paints.
const W = 400;
const H = 300;
const BODY =
  `<p style="font-family:serif">Hello <i>world</i> ∀ <input type=checkbox checked> ` +
  `<select><option>x</option></select></p><div style="height:900px"></div>`;

let browser: Browser | null = null;
afterAll(async () => {
  await closeBrowserSafely(browser);
}, 15_000);

async function newPage(): Promise<Page> {
  browser ??= await launchChromium();
  const ctx = await browser.newContext({ viewport: { width: W, height: H } });
  const page = await ctx.newPage();
  await page.setContent(`<html lang="en"><body style="margin:0">${BODY}</body></html>`);
  return page;
}

async function recordedSansSerif(page: Page): Promise<string | undefined> {
  const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: W, height: H });
  return tree[0].sessionGenericFamilies?.common["sans-serif"];
}

/** The face Chrome paints for a freshly inserted `sans-serif` span, named the
 *  way the record names it (PostScript on macOS, family elsewhere). */
let probeCount = 0;

async function paintedSansSerif(page: Page): Promise<string | undefined> {
  const id = `probe-${++probeCount}`;
  await page.evaluate((spanId) => {
    document.body.insertAdjacentHTML("beforeend", `<span id="${spanId}" style="font-family:sans-serif">Abc</span>`);
    // Platform fonts are read from layout, so lay the probe out first.
    return document.getElementById(spanId)?.getBoundingClientRect().width;
  }, id);
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument");
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: `#${id}` });
    const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
    const face = fonts[0];
    return process.platform === "darwin" ? face?.postScriptName || face?.familyName : face?.familyName;
  } finally {
    await page.evaluate((spanId) => document.getElementById(spanId)?.remove(), id);
    await cdp.detach();
  }
}

describe("generic-family Settings across captures on one Page", () => {
  it("keeps one record across repeated captures, including native-control rasters", async () => {
    const page = await newPage();
    try {
      const records = new Set<string>();
      for (let i = 0; i < 6; i++) {
        const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: W, height: H });
        records.add(JSON.stringify(tree[0].sessionGenericFamilies ?? null));
      }
      expect(records.size).toBe(1);
      expect([...records][0]).not.toBe("null");
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it("records what Chrome paints after a WebPreferences push resets the Page's families", async () => {
    const page = await newPage();
    try {
      const before = await recordedSansSerif(page);
      expect(before).toBe(await paintedSansSerif(page));
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Page.captureScreenshot", {
        clip: { x: 0, y: 0, width: 100, height: H + 200, scale: 1 },
        captureBeyondViewport: true,
      });
      await cdp.detach();
      const after = await recordedSansSerif(page);
      expect(after).toBe(await paintedSansSerif(page));
      // On macOS Playwright's table (Helvetica) differs from WebPreferences'
      // (Arial), so the reset is observable there; it proves the push happened.
      if (process.platform === "darwin") expect(after).not.toBe(before);
    } finally {
      await page.context().close();
    }
  }, 120_000);
});
