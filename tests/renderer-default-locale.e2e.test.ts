import { mkdir, writeFile } from "node:fs/promises";
import { arch, release } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { screenshotAfterPresentedFrame } from "../src/test-support/presented-frame-screenshot.js";
import { launchChromium, captureElementTreeWithWarnings } from "../src/capture/index.js";
import type { CapturedElement } from "../src/capture/types.js";
import { fontSelectionLanguage } from "../src/capture/font-locale.js";
import { rendererDefaultLocaleForPage } from "../src/capture/renderer-default-locale.js";
import { capturedFontFamilyCss } from "../src/font-family-stack.js";
import { getFontInstance, resolveFontKey, withRenderTextMode } from "../src/render/font-resolution.js";
import { capturedSessionGenericFamilies, elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import { withTextEngineDocument } from "../src/render/text-engine.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import { linuxApplicationLocale } from "../src/test-support/linux-application-locale.js";

/**
 * `font-locale: auto` selects with Blink's default locale — the launched
 * renderer's last `--lang` — through the per-script generic settings
 * (`FontSelector::FamilyNameFromSettings` reads `FontDescription::GetScript()`,
 * i.e. `LocaleOrDefault().GetScript()`) and the `-webkit-standard` family that
 * `FontFallbackList::GetFontData` appends after the author families. Each case
 * launches its own browser so the renderer `--lang` really differs.
 */
const flat = (tree: CapturedElement[]): CapturedElement[] => tree.flatMap((el) => [el, ...flat(el.children ?? [])]);
const W = 480,
  H = 360;
const ids = ["initial", "serif", "sans", "times", "helvetica"] as const;
const html =
  '<!doctype html><meta charset="utf-8"><style>body{margin:0}p{font-size:32px;line-height:44px;margin:0}' +
  "#initial{font-family:initial}#serif{font-family:serif}#sans{font-family:sans-serif}" +
  "#times{font-family:Times}#helvetica{font-family:Helvetica}</style>" +
  ids.map((id) => `<p id="${id}">直骨刃 ${id}</p>`).join("");

async function painted(page: Page, id: string) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument");
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: `#${id}` });
    const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
    return fonts;
  } finally {
    await cdp.detach();
  }
}

async function diffPct(page: Page, svg: string, source: Buffer): Promise<number> {
  await page.setContent(`<body style="margin:0">${svg}`);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const [a, b] = await Promise.all(
    [await page.screenshot(), source].map((png) => sharp(png).ensureAlpha().raw().toBuffer()),
  );
  let pixels = 0;
  for (let at = 0; at < a.length; at += 4) if (!a.subarray(at, at + 4).equals(b.subarray(at, at + 4))) pixels++;
  return (pixels / (W * H)) * 100;
}

/**
 * On Linux `--lang` does not set the application locale: it comes from the
 * environment (`ui/base/l10n/l10n_util.cc:508-577`, Chromium 7d859f27), and the
 * zygote-retitled renderer argv is cut before the appended `--lang`, so the
 * authority reads it from a utility child (DM-MGQCRJ). Each Linux case sets the
 * locale environment that yields the same language as the `--lang` case; the
 * exact tag then depends on which `locales/*.pak` the build ships
 * (`linuxApplicationLocale`): `ja` on Chrome for Testing x64, `ja-JP` on
 * Playwright's arm64 build, which ships none.
 */
const linuxEnv = (lang: string, language: string) => ({
  env: { ...process.env, LANG: `${lang}.UTF-8`, LC_ALL: `${lang}.UTF-8`, LANGUAGE: language },
});

describe("renderer default font locale (DM-JRG1BD)", () => {
  it.each([
    ["ja", "ja", "ja_JP"],
    ["zh-TW", "zh-TW", "zh_TW"],
    ["en_US", "en-US", "en_US"],
  ])("routes font-locale auto through the launched renderer's --lang=%s", async (lang, macWin, env) => {
    // A propagated duplicate must not win: the browser appends its own --lang last.
    const browser = await launchChromium({
      args: [`--lang=${lang}`],
      ...(process.platform === "linux" ? linuxEnv(env, env) : {}),
    });
    try {
      const expected = process.platform === "linux" ? await linuxApplicationLocale(browser, env) : macWin;
      const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
      await page.setContent(html);
      if (process.platform === "darwin" && expected === "en-US") {
        // Exercise the Chromium-default font table that a browser preference
        // push can restore on the hosted runner (doc 198, DM-B3VN3X).
        const cdp = await page.context().newCDPSession(page);
        try {
          await cdp.send("Page.captureScreenshot", {
            clip: { x: 0, y: 0, width: 100, height: H + 200, scale: 1 },
            captureBeyondViewport: true,
          });
        } finally {
          await cdp.detach();
        }
      }
      const authority = await rendererDefaultLocaleForPage(page);
      const source = await screenshotAfterPresentedFrame(page);
      const nativeFonts = Object.fromEntries(
        await Promise.all(ids.map(async (id) => [id, await painted(page, id)] as const)),
      );
      const capture = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: W, height: H });
      const elements = flat(capture.tree);
      const routes = withTextEngineDocument(
        { genericFamilies: capturedSessionGenericFamilies(capture.tree), generation: "continue" },
        () =>
          ids.map((id) => {
            const styles = elements.find((el) => el.text.trim().endsWith(`刃 ${id}`))?.styles;
            if (styles == null) return { id };
            const language = fontSelectionLanguage(styles);
            const key = resolveFontKey(capturedFontFamilyCss(styles.fontFamily, styles.fontFamilyStack), language);
            return {
              id,
              family: styles.fontFamily,
              stack: styles.fontFamilyStack,
              fontLocale: styles.fontLocale,
              defaultFontLocale: styles.defaultFontLocale,
              language,
              key,
              resolvedPostScriptName: getFontInstance(key, 400, 32)?.postscriptName,
            };
          }),
      ).value;
      const observedFamilies = await page
        .locator("p")
        .evaluateAll((paragraphs) => Object.fromEntries(paragraphs.map((p) => [p.id, getComputedStyle(p).fontFamily])));
      const evidence = {
        platform: process.platform,
        architecture: arch(),
        osRelease: release(),
        browser: browser.version(),
        sourceSha: process.env.GITHUB_SHA,
        lang,
        expected,
        authority,
        observedFamilies,
        nativeFonts,
        capturedGenericFamilies: capture.tree[0]?.sessionGenericFamilies,
        routes,
        warnings: capture.warnings,
      };
      const directory = join(process.env.DOMOTION_OUTPUT_DIR ?? "tests/output", "renderer-default-locale");
      await mkdir(directory, { recursive: true });
      const evidencePath = join(directory, `${expected}.json`);
      // Preserve source observations before a strict route assertion can fail.
      await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
      expect(authority).toEqual({ locale: expected });
      for (const route of routes) {
        const { id } = route;
        expect(route.fontLocale, id).toBe("auto");
        expect(route.defaultFontLocale, id).toBe(expected);
        expect(route.language, id).toBe(expected);
        // Each platform's generic tables have their own coverage.
        if (process.platform === "darwin" && (id === "initial" || id === "serif" || id === "sans")) {
          expect(
            nativeFonts[id]?.map((font) => font.postScriptName),
            id,
          ).toContain(route.resolvedPostScriptName);
        }
      }
      // Negative control: drop the authority and the rendering must move away
      // from Chromium (or, for an en-US renderer on an en-US host, not change).
      const legacy = structuredClone(capture.tree);
      for (const el of flat(legacy)) delete el.styles.defaultFontLocale;
      const current = withRenderTextMode("paths", () => elementTreeToSvg(capture.tree, W, H));
      const without = withRenderTextMode("paths", () => elementTreeToSvg(legacy, W, H));
      const diffs = { current: await diffPct(page, current, source), without: await diffPct(page, without, source) };
      await writeFile(evidencePath, JSON.stringify({ ...evidence, diffs }, null, 2));
      if (process.platform === "darwin" && expected !== "en-US")
        expect(diffs.current, JSON.stringify(diffs)).toBeLessThan(diffs.without);
      else expect(diffs.current, JSON.stringify(diffs)).toBeLessThanOrEqual(diffs.without);
    } finally {
      await closeBrowserSafely(browser);
    }
  });

  it("is unknown when disabled, keeping the legacy route", async () => {
    const browser = await launchChromium({ args: ["--lang=ja"] });
    const previous = process.env.DOMOTION_RENDERER_DEFAULT_LOCALE;
    process.env.DOMOTION_RENDERER_DEFAULT_LOCALE = "0";
    try {
      const page = await browser.newPage({ viewport: { width: W, height: H } });
      await page.setContent(html);
      expect(await rendererDefaultLocaleForPage(page)).toMatchObject({ reason: expect.any(String) });
      const capture = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: W, height: H });
      for (const el of flat(capture.tree)) expect(el.styles.defaultFontLocale).toBeUndefined();
    } finally {
      if (previous == null) delete process.env.DOMOTION_RENDERER_DEFAULT_LOCALE;
      else process.env.DOMOTION_RENDERER_DEFAULT_LOCALE = previous;
      await closeBrowserSafely(browser);
    }
  });
});
