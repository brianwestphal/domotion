import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Browser, Page } from "@playwright/test";
import { __pickWebfontVariantMetaForTest, resolveFont } from "@domotion/text-engine/testing";
import { launchChromium } from "../src/capture/index.js";
import { clearWebfonts, registerWebfont } from "../src/render/font-resolution.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// Two @font-face capability groups that differ only in slope, discriminated by
// their bytes (JetBrains Mono vs IBM Plex Serif). Chrome's FontFaceCache picks
// one group by FontSelectionAlgorithm::StyleDistance
// (platform/fonts/font_selection_algorithm.cc:53-96, Chromium 7d859f27); the
// winner of these cases is unique, so it must not depend on source order.
const fixture = (name: string) =>
  readFileSync(new URL(`../packages/text-engine/assets/fonts/fixture/${name}`, import.meta.url));
const faces = { mono: fixture("DomotionFixtureMono-Regular.ttf"), serif: fixture("DomotionFixtureSerif-Regular.ttf") };

let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(async () => {
  clearWebfonts();
  await closeBrowserSafely(browser);
});

async function nativeFace(page: Page, css: string, requestStyle: string): Promise<string> {
  await page.setContent(
    `<style>${css} #t{font:400 20px Slope;font-style:${requestStyle};font-synthesis:none}</style><span id="t">Rag</span>`,
  );
  await page.evaluate(() => document.fonts.ready);
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument");
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#t" });
    const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
    expect(fonts).toHaveLength(1);
    expect(fonts[0].isCustomFont).toBe(true);
    return fonts[0].postScriptName;
  } finally {
    await cdp.detach();
  }
}

/** What the replaced boolean rule chose: every non-normal descriptor matched an
 *  italic request equally, so the last declaration won any tie. */
function legacyBooleanChoice(order: string[], requestSlope: number): number {
  let best = -1;
  let bestScore = Infinity;
  order.forEach((style, index) => {
    const score = (style !== "normal") === (requestSlope !== 0) ? 0 : 1;
    if (score <= bestScore) {
      bestScore = score;
      best = index;
    }
  });
  return best;
}

it.each([
  {
    name: "italic request: italic beats oblique 0-12",
    style: "italic",
    slope: 14,
    mono: "oblique 0deg 12deg",
    serif: "italic",
  },
  {
    name: "normal request: oblique 5-10 beats italic",
    style: "normal",
    slope: 0,
    mono: "oblique 5deg 10deg",
    serif: "italic",
  },
  {
    name: "oblique -10deg request",
    style: "oblique -10deg",
    slope: -10,
    mono: "oblique -20deg",
    serif: "oblique 5deg",
  },
  { name: "oblique 20deg request", style: "oblique 20deg", slope: 20, mono: "oblique 30deg", serif: "oblique 10deg" },
  { name: "oblique 5deg request", style: "oblique 5deg", slope: 5, mono: "oblique 10deg", serif: "oblique -2deg" },
  {
    name: "oblique -20deg request",
    style: "oblique -20deg",
    slope: -20,
    mono: "oblique -30deg",
    serif: "oblique -5deg",
  },
  { name: "quarter-grid descriptors", style: "italic", slope: 14, mono: "oblique 13.9deg", serif: "oblique 14.1deg" },
])("matches Chrome's StyleDistance group choice: $name", async ({ style, slope, mono, serif }) => {
  const page = await browser.newPage();
  let legacyDisagreements = 0;
  try {
    const native: string[] = [];
    for (const order of [
      ["mono", "serif"],
      ["serif", "mono"],
    ] as const) {
      const descriptor = { mono, serif };
      const css = order
        .map(
          (key) =>
            `@font-face{font-family:Slope;src:url(data:font/ttf;base64,${faces[key].toString("base64")});font-weight:400;font-stretch:100%;font-style:${descriptor[key]}}`,
        )
        .join("");
      const chromeFace = await nativeFace(page, css, style);
      native.push(chromeFace);

      clearWebfonts();
      for (const key of order)
        expect(
          registerWebfont("Slope", 400, descriptor[key], faces[key], undefined, "100%", "400", descriptor[key]),
        ).toBe(true);
      const meta = __pickWebfontVariantMetaForTest("Slope", 400, slope !== 0, 100, slope);
      if (meta == null) throw new Error("no webfont variant selected");
      const chosen = order[meta.declarationIndex];
      const engineFace = (chosen === "mono" ? "JetBrainsMono" : "IBMPlexSerif") + "-Regular";
      expect(engineFace).toBe(chromeFace);
      if (
        order[
          legacyBooleanChoice(
            [...order].map((key) => descriptor[key]),
            slope,
          )
        ] !== chosen
      )
        legacyDisagreements++;

      // The shipped primary-font path agrees when the request needs no angle.
      if (slope === 0 || slope === 14)
        expect(resolveFont("Slope", 400, 20, slope === 0 ? 0 : 14)?.postscriptName).toBe(chromeFace);
    }
    expect(native[0]).toBe(native[1]);
    // Negative control: the replaced boolean rule is order-dependent here, so
    // it disagrees with Chrome in exactly one of the two source orders.
    expect(legacyDisagreements).toBe(1);
  } finally {
    clearWebfonts();
    await page.close();
  }
});
