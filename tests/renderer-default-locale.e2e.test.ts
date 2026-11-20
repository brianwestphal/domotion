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

async function painted(page: Page, id: string): Promise<string[]> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument");
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: `#${id}` });
    const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
    return fonts.map((f) => f.postScriptName);
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
 * locale environment that yields the same language as the `--lang` case.
 */
const linuxEnv = (lang: string, language: string) => ({
  env: { ...process.env, LANG: `${lang}.UTF-8`, LC_ALL: `${lang}.UTF-8`, LANGUAGE: language },
});

describe("renderer default font locale (DM-JRG1BD)", () => {
  it.each([
    ["ja", "ja", "ja_JP", "ja-JP"],
    ["zh-TW", "zh-TW", "zh_TW", "zh-TW"],
    ["en_US", "en-US", "en_US", "en-US"],
  ])("routes font-locale auto through the launched renderer's --lang=%s", async (lang, macWin, env, linux) => {
    const expected = process.platform === "linux" ? linux : macWin;
    // A propagated duplicate must not win: the browser appends its own --lang last.
    const browser = await launchChromium({
      args: [`--lang=${lang}`],
      ...(process.platform === "linux" ? linuxEnv(env, env) : {}),
    });
    try {
      const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
      await page.setContent(html);
      const authority = await rendererDefaultLocaleForPage(page);
      expect(authority).toEqual({ locale: expected });
      const source = await page.screenshot();
      const nativeFaces = Object.fromEntries(await Promise.all(ids.map(async (id) => [id, await painted(page, id)])));
      const capture = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: W, height: H });
      const elements = flat(capture.tree);
      for (const id of ids) {
        const owner = elements.find((el) => el.text.trim().endsWith(`刃 ${id}`))!;
        expect(owner.styles.fontLocale, id).toBe("auto");
        expect(owner.styles.defaultFontLocale, id).toBe(expected);
        expect(fontSelectionLanguage(owner.styles), id).toBe(expected);
      }
      // Generic-family primaries resolve to the face Chromium paints. The
      // darwin family tables carry these per-script faces; other hosts' generic
      // tables are proved by their own platform suites.
      for (const id of process.platform === "darwin" ? (["initial", "serif", "sans"] as const) : []) {
        const owner = elements.find((el) => el.text.trim().endsWith(`刃 ${id}`))!;
        const key = resolveFontKey(
          capturedFontFamilyCss(owner.styles.fontFamily, owner.styles.fontFamilyStack),
          fontSelectionLanguage(owner.styles),
        );
        expect(nativeFaces[id], id).toContain(getFontInstance(key, 400, 32)?.postscriptName);
      }
      // Negative control: drop the authority and the rendering must move away
      // from Chromium (or, for an en-US renderer on an en-US host, not change).
      const legacy = structuredClone(capture.tree);
      for (const el of flat(legacy)) delete el.styles.defaultFontLocale;
      const current = withRenderTextMode("paths", () => elementTreeToSvg(capture.tree, W, H));
      const without = withRenderTextMode("paths", () => elementTreeToSvg(legacy, W, H));
      const diffs = { current: await diffPct(page, current, source), without: await diffPct(page, without, source) };
      const directory = join(process.env.DOMOTION_OUTPUT_DIR ?? "tests/output", "renderer-default-locale");
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, `${expected}.json`),
        JSON.stringify({ platform: process.platform, browser: browser.version(), nativeFaces, diffs }, null, 2),
      );
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
