import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Browser } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchChromium, captureElementTreeWithWarnings } from "../src/capture/index.js";
import type { CapturedElement } from "../src/capture/types.js";
import { fontSelectionLanguage } from "../src/capture/font-locale.js";
import { probePageGenericFamilies } from "../src/capture/generic-font-probe.js";
import { capturedFontFamilyCss } from "../src/font-family-stack.js";
import { getFontInstance, resolveFontKey, withRenderTextMode } from "../src/render/font-resolution.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(async () => closeBrowserSafely(browser));
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const flat = (tree: CapturedElement[]): CapturedElement[] => tree.flatMap((el) => [el, ...flat(el.children ?? [])]);
const W = 640,
  H = 440;
const root = () =>
  process.env.DOMOTION_FONT_LOCALE_EVIDENCE ??
  (process.env.DOMOTION_OUTPUT_DIR ?? "tests/output") + "/computed-font-locale";

describe("computed font locale distinct from document language (DM-PJG8E9)", () => {
  it("routes explicit/inherited/reset CSS strings and XML identity without changing DOM language", async () => {
    const context = await browser.newContext({ locale: "ja", viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const directory = join(root(), "selection");
    const evidence: Record<string, unknown> = {
      generatedAt: new Date().toISOString(),
      sourceCommit: process.env.GITHUB_SHA ?? null,
      platform: process.platform,
      arch: process.arch,
      browser: browser.version(),
      node: process.version,
    };
    let failed = false;
    try {
      const cases = [
        { id: "dom-ja", lang: "ja", style: "", expected: "ja" },
        { id: "css-ja", lang: "en", style: '-webkit-locale:"ja"', expected: "ja" },
        { id: "css-en", lang: "ja", style: '-webkit-locale:"en"', expected: "en" },
        { id: "css-empty", lang: "ja", style: '-webkit-locale:""', expected: "" },
        { id: "inherit", lang: "en", style: "-webkit-locale:inherit", parent: true, expected: "ja" },
        { id: "unset", lang: "en", style: "-webkit-locale:unset", parent: true, expected: "ja" },
        { id: "variable", lang: "en", style: '--language:"ja";-webkit-locale:var(--language)', expected: "ja" },
        { id: "xml", lang: "en", style: "", expected: "ja" },
        { id: "auto", lang: "ja", style: "-webkit-locale:auto", unknown: true },
        { id: "initial", lang: "ja", style: "-webkit-locale:initial", unknown: true },
      ];
      const html =
        '<!doctype html><html lang="en"><style>body{margin:0}p{font-size:32px;line-height:44px;margin:0}.parent{-webkit-locale:"ja"}</style><body>' +
        cases
          .map(
            (c) =>
              `${"parent" in c ? '<div class="parent">' : ""}<p id="${c.id}" lang="${c.lang}" style='${c.style}'><span id="a-${c.id}">A</span>漢 ${c.id}</p>${"parent" in c ? "</div>" : ""}`,
          )
          .join("") +
        "</body></html>";
      await page.setContent(html);
      await page
        .locator("#xml")
        .evaluate((el) => el.setAttributeNS("http://www.w3.org/XML/1998/namespace", "xml:lang", "ja"));
      evidence.webLocales = await page.evaluate(() => ({
        navigatorLanguage: navigator.language,
        intlLocale: new Intl.DateTimeFormat().resolvedOptions().locale,
      }));
      const sourcePng = await page.screenshot();
      const session = await context.newCDPSession(page);
      const rows: Array<{
        id: string;
        locale: string;
        width: number;
        painted: { familyName: string; postScriptName: string };
        fontKey: string;
        fontkitAdvance: number;
      }> = [];
      evidence.rows = rows;
      try {
        await session.send("DOM.enable");
        await session.send("CSS.enable");
        const { root: dom } = await session.send("DOM.getDocument");
        for (const c of cases) {
          const state = await page.locator(`#a-${c.id}`).evaluate((el) => {
            const cs = getComputedStyle(el),
              range = document.createRange();
            range.selectNodeContents(el);
            return { locale: cs.getPropertyValue("-webkit-locale"), width: range.getBoundingClientRect().width };
          });
          const { nodeId } = await session.send("DOM.querySelector", { nodeId: dom.nodeId, selector: `#a-${c.id}` });
          const { fonts } = await session.send("CSS.getPlatformFontsForNode", { nodeId });
          const painted = fonts.filter((font) => font.glyphCount > 0);
          expect(painted).toHaveLength(1);
          const fontKey = resolveFontKey(painted[0].familyName, "ja"),
            font = getFontInstance(fontKey, 400, 32);
          expect(font?.postscriptName, c.id).toBe(painted[0].postScriptName);
          const advance = (font!.glyphForCodePoint(65).advanceWidth! / font!.unitsPerEm) * 32;
          rows.push({ id: c.id, ...state, painted: painted[0], fontKey, fontkitAdvance: advance });
          expect(Math.abs(advance - state.width), c.id).toBeLessThanOrEqual(1 / 64);
        }
      } finally {
        await session.detach();
      }
      const capture = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: W, height: H });
      const elements = flat(capture.tree);
      for (const c of cases) {
        const owner = elements.find((el) => el.text.trim().endsWith(`漢 ${c.id}`));
        expect(owner, c.id).toBeDefined();
        const row = rows.find((r) => r.id === c.id)!;
        expect(owner!.styles.lang, c.id).toBe(c.lang);
        expect(owner!.styles.fontLocale, c.id).toBe(row.locale);
        expect(fontSelectionLanguage(owner!.styles), c.id).toBe("unknown" in c ? c.lang : c.expected);
        if (!("unknown" in c)) {
          const fontKey = resolveFontKey(
            capturedFontFamilyCss(owner!.styles.fontFamily, owner!.styles.fontFamilyStack),
            fontSelectionLanguage(owner!.styles),
          );
          expect(getFontInstance(fontKey, 400, 32)?.postscriptName, c.id).toBe(row.painted.postScriptName);
        }
      }
      const cssOwner = elements.find((el) => el.text.trim().endsWith("漢 css-ja"))!;
      if (process.platform === "darwin") {
        const family = capturedFontFamilyCss(cssOwner.styles.fontFamily, cssOwner.styles.fontFamilyStack);
        expect(resolveFontKey(family, cssOwner.styles.lang)).not.toBe(
          resolveFontKey(family, fontSelectionLanguage(cssOwner.styles)),
        );
      }
      expect(await page.screenshot(), "source rollback").toEqual(sourcePng);
      const legacy = structuredClone(capture.tree);
      for (const el of flat(legacy)) {
        delete el.styles.fontLocale;
        for (const pseudo of el.pseudoFragments ?? []) delete pseudo.typography.fontLocale;
      }
      const oldSvg = withRenderTextMode("embedded-font", () => elementTreeToSvg(legacy, W, H));
      const newSvg = withRenderTextMode("embedded-font", () => elementTreeToSvg(capture.tree, W, H));
      const pngs = [];
      for (const svg of [oldSvg, newSvg]) {
        await page.setContent(`<body style="margin:0">${svg}`);
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        pngs.push(await page.screenshot());
      }
      const expected = await sharp(sourcePng).ensureAlpha().raw().toBuffer();
      const diffs = [];
      for (const png of pngs) {
        const actual = await sharp(png).ensureAlpha().raw().toBuffer();
        let pixels = 0;
        for (let at = 0; at < actual.length; at += 4)
          if (!actual.subarray(at, at + 4).equals(expected.subarray(at, at + 4))) pixels++;
        diffs.push((pixels / (W * H)) * 100);
      }
      if (process.platform === "darwin") expect(diffs[1]).toBeLessThan(diffs[0]);
      Object.assign(evidence, {
        fixtureHtmlSha256: hash(html),
        fixtureSha256: hash(await readFile(new URL(import.meta.url))),
        captureBundleSha256: hash(await readFile(new URL("../src/capture/script.generated.ts", import.meta.url))),
        rows,
        styles: cases.map((c) => ({
          id: c.id,
          styles: elements.find((el) => el.text.trim().endsWith(`漢 ${c.id}`))!.styles,
        })),
        warnings: capture.warnings,
        diffPct: { legacy: diffs[0], current: diffs[1] },
        passed: true,
      });
      await mkdir(directory, { recursive: true });
      await Promise.all([
        writeFile(join(directory, "source.png"), sourcePng),
        writeFile(join(directory, "legacy.png"), pngs[0]),
        writeFile(join(directory, "captured.png"), pngs[1]),
        writeFile(join(directory, "source.html"), html),
        writeFile(join(directory, "legacy.svg"), oldSvg),
        writeFile(join(directory, "captured.svg"), newSvg),
      ]);
    } catch (error) {
      failed = true;
      evidence.failed = true;
      throw error;
    } finally {
      try {
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, "results.json"), JSON.stringify(evidence, null, 2));
      } catch (error) {
        if (!failed) throw error;
      } finally {
        await context.close();
      }
    }
  });

  it("observes a CSS-only script in the existing owned generic probe and preserves pseudo locale", async () => {
    const context = await browser.newContext({ viewport: { width: 360, height: 100 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const directory = join(root(), "css-only-script");
    const evidence: Record<string, unknown> = {
      generatedAt: new Date().toISOString(),
      sourceCommit: process.env.GITHUB_SHA ?? null,
      platform: process.platform,
      browser: browser.version(),
    };
    let failed = false;
    try {
      const html =
        '<style>body{margin:0}p{font-size:32px;margin:0}#pseudo::before{content:"A";-webkit-locale:"ja"}</style><p id="pseudo" lang="en">A</p><p id="css">A</p>';
      await page.setContent(html);
      Object.assign(evidence, {
        fixtureHtmlSha256: hash(html),
        fixtureSha256: hash(await readFile(new URL(import.meta.url))),
        captureBundleSha256: hash(await readFile(new URL("../src/capture/script.generated.ts", import.meta.url))),
        node: process.version,
        arch: process.arch,
      });
      const cdp = await context.newCDPSession(page);
      try {
        await cdp.send("Page.setFontFamilies", {
          fontFamilies: {},
          forScripts: [{ script: "Beng", fontFamilies: { standard: "Arial", serif: "Arial" } }],
        });
      } finally {
        await cdp.detach();
      }
      const without = await probePageGenericFamilies(page);
      expect(without).not.toBeNull();
      expect(without!.byScript.has("BENGALI")).toBe(false);
      await page.locator("#css").evaluate((el) => (el as HTMLElement).style.setProperty("-webkit-locale", '"bn"'));
      const withCss = await probePageGenericFamilies(page);
      expect(withCss).not.toBeNull();
      expect(withCss!.byScript.has("BENGALI")).toBe(true);
      expect(withCss!.byScript.get("BENGALI")!.get("standard")).toBeTruthy();
      expect(withCss!.byScript.get("BENGALI")!.get("standard")).not.toBe(without!.common.get("standard"));
      const capture = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 360, height: 100 });
      const pseudo = flat(capture.tree)
        .flatMap((el) => el.pseudoFragments ?? [])
        .find((record) => record.pseudo === "::before");
      expect(pseudo?.status).toBe("exact");
      expect(pseudo?.typography.fontLocale).toBe('"ja"');
      expect(pseudo?.typography.language).toBe("en");
      expect(fontSelectionLanguage(pseudo!.typography)).toBe("ja");
      const painted = pseudo!.typography.resolvedFonts.filter((font) => font.glyphCount > 0);
      expect(painted).toHaveLength(1);
      const fontKey = resolveFontKey(
        capturedFontFamilyCss(pseudo!.typography.fontFamily, pseudo!.typography.fontFamilyStack),
        fontSelectionLanguage(pseudo!.typography),
      );
      expect(getFontInstance(fontKey, 400, 32)?.postscriptName).toBe(painted[0].postScriptName);
      if (process.platform === "darwin")
        expect(
          resolveFontKey(
            capturedFontFamilyCss(pseudo!.typography.fontFamily, pseudo!.typography.fontFamilyStack),
            pseudo!.typography.language,
          ),
        ).not.toBe(fontKey);
      Object.assign(evidence, {
        withoutBengali: without!.byScript.has("BENGALI"),
        withBengali: Object.fromEntries(withCss!.byScript.get("BENGALI")!),
        pseudo: pseudo!.typography,
        passed: true,
      });
    } catch (error) {
      failed = true;
      evidence.failed = true;
      throw error;
    } finally {
      try {
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, "results.json"), JSON.stringify(evidence, null, 2));
      } catch (error) {
        if (!failed) throw error;
      } finally {
        await context.close();
      }
    }
  });
});
