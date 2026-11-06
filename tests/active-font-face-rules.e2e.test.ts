import type { Browser, Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchChromium } from "../src/index.js";
import { scanActiveFontFaceRules } from "../src/capture/active-font-face-rules.js";
import { localFaceFromFontFaceDescriptors } from "../src/capture/cross-origin-font-face.js";
import { evaluateInFrame } from "../src/capture/evaluate-in-frame.js";
import { discoverAndRegisterWebfonts, resolveLocalFaceAliases } from "../src/capture/index.js";
import { createTextEngineSession } from "../src/render/text-engine.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import { FIXTURE_FONT_CSS } from "./fixture-fonts.js";

// Webfont discovery keeps exactly the @font-face rules Blink adds to the
// document's font-face set (Chromium 7d859f27): RuleSet::AddChildRules
// (core/css/rule_set.cc:973-1080) enters @media only when it matches, @supports
// only when supported, and @container / @layer / @scope / @starting-style
// unconditionally; AddRulesFromSheet (:1294-1330) follows an @import only when
// its supports() and media conditions hold; RuleSetForSheet
// (style_engine.cc:1016-1022) and CanBeActivated (css_style_sheet.cc:686-711)
// drop media-mismatched and disabled sheets. The same-origin walker used to
// skip every nested rule.

const css = (text: string): string => `data:text/css,${encodeURIComponent(text)}`;
const face = (family: string): string => `@font-face { font-family: ${family}; src: url(${family}.woff2); }`;

let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await launchChromium({ headless: true });
  page = await browser.newPage({ viewport: { width: 800, height: 600 } });
});
afterAll(async () => {
  await closeBrowserSafely(browser);
});

describe("scanActiveFontFaceRules over the document", () => {
  it("keeps only the rules Blink activates, in document order", async () => {
    await page.setContent(`<!doctype html>
      <style>
        @import url("${css(face("Imported"))}");
        @import url("${css(face("ImportedPrint"))}") print;
        @import url("${css(face("ImportedUnsupported"))}") supports(not-a-property: 1);
        ${face("Top")}
        @media (min-width: 400px) { ${face("WideViewport")} }
        @media (min-width: 4000px) { ${face("HugeViewport")} }
        @supports (display: grid) { @layer brand { ${face("SupportsLayer")} } }
        @supports not (display: grid) { ${face("NotGrid")} }
        @container (min-width: 1px) { ${face("Container")} }
        @scope (.card) { ${face("Scoped")} }
        @starting-style { ${face("Starting")} }
      </style>
      <style media="print">${face("PrintSheet")}</style>
      <style id="off">${face("DisabledSheet")}</style>
      <p>x</p>`);
    await page.evaluate(() => {
      (document.getElementById("off") as HTMLStyleElement).sheet!.disabled = true;
      const adopted = new CSSStyleSheet();
      adopted.replaceSync(`@font-face { font-family: Adopted; src: url(Adopted.woff2); }
        @media print { @font-face { font-family: AdoptedPrint; src: url(AdoptedPrint.woff2); } }`);
      document.adoptedStyleSheets = [adopted];
    });
    const scan = await evaluateInFrame(page, scanActiveFontFaceRules, null);
    expect(scan.rules.map((r) => r.family)).toEqual([
      "Imported",
      "Top",
      "WideViewport",
      "SupportsLayer",
      "Container",
      "Scoped",
      "Starting",
      "Adopted",
    ]);
    expect(scan.crossOriginSheetUrls).toEqual([]);
    // Chrome's own answer: document.fonts lists the CSS-connected faces of
    // exactly the active rules.
    expect(await page.evaluate(() => Array.from(document.fonts, (f) => f.family))).toEqual(
      scan.rules.map((r) => r.family),
    );
  });

  it("registers a webfont declared inside a matching @media block", async () => {
    await page.setContent(`<!doctype html><style>@media screen { ${FIXTURE_FONT_CSS} }</style><p>x</p>`);
    await page.evaluate(() => document.fonts.ready);
    const report = await discoverAndRegisterWebfonts(page, [], createTextEngineSession());
    expect(report.filter((r) => r.source === "font-face").map((r) => r.ok)).toEqual([true, true]);
  });

  // Chrome's local() lookup matches a PostScript / full name, so local("Menlo")
  // misses and the alias resolves to Monaco; the width probe must report the
  // candidate Chrome actually painted. macOS ships both faces.
  it.runIf(process.platform === "darwin")("resolves a local() alias to the candidate Chrome paints", async () => {
    await page.setContent(`<!doctype html>
      <style>@media screen { @font-face { font-family: Alias; src: local("Menlo"), local("Monaco"); } }</style>
      <p style="font-family: Alias">mIw0</p>`);
    await page.evaluate(() => document.fonts.ready);
    const scan = await evaluateInFrame(page, scanActiveFontFaceRules, null);
    const faces = scan.rules.map((r) => localFaceFromFontFaceDescriptors(r)).filter((f) => f != null);
    await resolveLocalFaceAliases(page, faces);
    expect(faces.map((f) => [f.family, f.resolvedLocalName])).toEqual([["Alias", "Monaco"]]);
  });

  // The preferred stylesheet set: Blink keeps a titled sheet only when its
  // title is the document's preferred set name, which the first titled
  // <style>, titled non-alternate <link rel=stylesheet>, or
  // <meta http-equiv=default-style> sets; an untitled alternate sheet is never
  // active (CSSStyleSheet::CanBeActivated, css_style_sheet.cc:686-711).
  // Chrome's own answer is `document.fonts`, which lists the CSS-connected
  // faces of exactly the active rules; each case asserts the scan agrees with
  // it. A fresh page per case: the preferred name survives `setContent`.
  const titledCases: Record<string, string> = {
    "first titled sheet wins": `<link rel=stylesheet title=A href="${css(face("LinkA"))}">
      <link rel=stylesheet title=B href="${css(face("LinkB"))}">
      <style title=A>${face("StyleA")}</style><style title=C>${face("StyleC")}</style><style>${face("Untitled")}</style>`,
    "untitled alternate is inactive, titled alternate needs the preferred name": `
      <link rel="alternate stylesheet" href="${css(face("AltUntitled"))}">
      <link rel="alternate stylesheet" title=X href="${css(face("AltX"))}"><style>${face("Plain")}</style>`,
    "meta default-style names the set": `<meta http-equiv="Default-Style" content="Y">
      <style title=X>${face("StyleX")}</style><style title=Y>${face("StyleY")}</style>`,
    "a titled style sets the name an alternate link then matches": `<style title=Z>${face("StyleZ")}</style>
      <link rel="alternate stylesheet" title=Z href="${css(face("AltZ"))}">
      <link rel=stylesheet title=W href="${css(face("LinkW"))}">`,
  };
  for (const [label, body] of Object.entries(titledCases)) {
    it(`titled / alternate sheets: ${label}`, async () => {
      const fresh = await browser.newPage();
      await fresh.setContent(`<!doctype html>${body}<p>x</p>`);
      const scan = await evaluateInFrame(fresh, scanActiveFontFaceRules, null);
      const chrome = await fresh.evaluate(() => Array.from(document.fonts, (f) => f.family));
      expect(scan.rules.map((r) => r.family)).toEqual(chrome);
      expect(chrome.length).toBeGreaterThan(0);
      await fresh.close();
    });
  }
});
