import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { launchChromium, captureElementTreeWithWarnings } from "../src/capture/index.js";
import type { CapturedElement } from "../src/capture/types.js";
import { fontSelectionLanguage } from "../src/capture/font-locale.js";
import { rendererDefaultLocaleForPage } from "../src/capture/renderer-default-locale.js";
import { capturedFontFamilyCss } from "../src/font-family-stack.js";
import { getFontInstance, resolveFontKey, withRenderTextMode } from "../src/render/font-resolution.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import { linuxApplicationLocale } from "../src/test-support/linux-application-locale.js";

/**
 * DM-XWGRJC: the two capture-side consumers of the font-selection language —
 * bitmap-glyph raster span selection and the standard-family-type usability
 * gate — follow `fontSelectionLanguage`, so a renderer launched with `--lang=ja`
 * routes `font-locale: auto` through its default locale everywhere.
 *
 * `#reset` is `all:initial` under `lang="en"`: its computed `-webkit-locale` is
 * `auto` and its family is the standard generic, so Blink selects with the
 * renderer default (`FontSelector::FamilyNameFromSettings` reads
 * `LocaleOrDefault().GetScript()`, Chromium 7d859f27). DOM language is "en",
 * which is not the locale Chromium uses.
 */
const flat = (tree: CapturedElement[]): CapturedElement[] => tree.flatMap((el) => [el, ...flat(el.children ?? [])]);
const W = 480,
  H = 200;
const html =
  '<!doctype html><meta charset="utf-8"><style>body{margin:0}p{font-size:32px;line-height:44px;margin:0}' +
  "#reset{all:initial;display:block;font-size:32px;line-height:44px}</style>" +
  '<div lang="en"><p id="reset">直骨刃 reset</p></div>' +
  '<p id="nolang">直骨 ✌ ☀ ⌚ nolang</p>';

async function painted(page: Page, selector: string): Promise<string[]> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument");
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
    return fonts.filter((f) => f.glyphCount > 0).map((f) => f.postScriptName);
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

async function captureWithAuthority(page: Page, enabled: boolean) {
  const previous = process.env.DOMOTION_RENDERER_DEFAULT_LOCALE;
  if (!enabled) process.env.DOMOTION_RENDERER_DEFAULT_LOCALE = "0";
  try {
    return await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: W, height: H });
  } finally {
    if (previous == null) delete process.env.DOMOTION_RENDERER_DEFAULT_LOCALE;
    else process.env.DOMOTION_RENDERER_DEFAULT_LOCALE = previous;
  }
}

describe("renderer default font locale consumers (DM-XWGRJC)", () => {
  it("routes raster spans and the standard family type through --lang=ja", async () => {
    // Linux takes the application locale from the environment (DM-MGQCRJ).
    const browser = await launchChromium({
      args: ["--lang=ja"],
      ...(process.platform === "linux"
        ? { env: { ...process.env, LANG: "ja_JP.UTF-8", LC_ALL: "ja_JP.UTF-8", LANGUAGE: "ja_JP" } }
        : {}),
    });
    try {
      // `ja` on Chrome for Testing x64, `ja-JP` on a build without locale paks.
      const expected = process.platform === "linux" ? await linuxApplicationLocale(browser, "ja_JP") : "ja";
      const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
      await page.setContent(html);
      const authority = await rendererDefaultLocaleForPage(page);
      const source = await page.screenshot();
      const native = { reset: await painted(page, "#reset"), nolang: await painted(page, "#nolang") };
      const current = await captureWithAuthority(page, true);
      const without = await captureWithAuthority(page, false);
      const find = (tree: CapturedElement[], suffix: string) =>
        flat(tree).find((el) => el.text.trim().endsWith(suffix))!;
      expect(authority).toEqual({ locale: expected });
      const reset = find(current.tree, "reset"),
        resetWithout = find(without.tree, "reset");
      expect(reset.styles.fontLocale).toBe("auto");
      expect(reset.styles.lang).toBe("en");
      expect(fontSelectionLanguage(reset.styles)).toBe(expected);
      // With the authority the standard type is routable and no locale warning fires.
      expect(reset.styles.fontFamilyStack?.genericFamily).toBe("standard");
      expect(current.warnings.some((w) => w.detail.includes("DM-PJG8E9"))).toBe(false);
      // Negative control: without it, the gate refuses the standard type and warns.
      expect(resetWithout.styles.defaultFontLocale).toBeUndefined();
      expect(without.warnings.some((w) => w.detail.includes("DM-PJG8E9"))).toBe(true);
      if (process.platform === "darwin") {
        const key = resolveFontKey(
          capturedFontFamilyCss(reset.styles.fontFamily, reset.styles.fontFamilyStack),
          fontSelectionLanguage(reset.styles),
        );
        expect(native.reset).toContain(getFontInstance(key, 400, 32)?.postscriptName);
      }
      // The no-lang run's raster spans select with "ja" and must agree with
      // Chromium's color face: rasterized exactly where it painted a color font.
      const nolang = find(current.tree, "nolang");
      expect(nolang.styles.defaultFontLocale).toBe(expected);
      const rasterChars = (el: CapturedElement) =>
        (el.textPaintGeometry?.neutral?.textSegments ?? el.textSegments ?? [])
          .flatMap((seg) =>
            (seg.rasterGlyphs ?? [])
              .filter((g) => g.dataUri != null)
              .map((g) => seg.text.slice(g.charIndex, g.charIndex + (g.charLength ?? 1))),
          )
          .join("");
      if (process.platform === "darwin") {
        expect(native.nolang).toContain("AppleColorEmoji");
        expect(rasterChars(nolang)).toBe("✌⌚");
      }
      const svgCurrent = withRenderTextMode("paths", () => elementTreeToSvg(current.tree, W, H));
      const svgWithout = withRenderTextMode("paths", () => elementTreeToSvg(without.tree, W, H));
      const diffs = {
        current: await diffPct(page, svgCurrent, source),
        without: await diffPct(page, svgWithout, source),
      };
      const directory = join(process.env.DOMOTION_OUTPUT_DIR ?? "tests/output", "renderer-default-locale-consumers");
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, `${expected}.json`),
        JSON.stringify({ platform: process.platform, browser: browser.version(), native, diffs }, null, 2),
      );
      if (process.platform === "darwin") expect(diffs.current, JSON.stringify(diffs)).toBeLessThan(diffs.without);
      else expect(diffs.current, JSON.stringify(diffs)).toBeLessThanOrEqual(diffs.without);
    } finally {
      await closeBrowserSafely(browser);
    }
  });
});
