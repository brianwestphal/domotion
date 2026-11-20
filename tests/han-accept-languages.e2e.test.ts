import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { isGlyphHelperAvailable, withFontLocaleForHan } from "@domotion/text-engine/testing";
import { describe, expect, it } from "vitest";
import { captureElementTreeWithWarnings, launchChromium } from "../src/capture/index.js";
import { fontSelectionLanguage } from "../src/capture/font-locale.js";
import { browserAcceptLanguagesForPage, rendererDefaultLocaleForPage } from "../src/capture/renderer-default-locale.js";
import type { CapturedElement } from "../src/capture/types.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import { withRenderTextMode } from "../src/render/font-resolution.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import { ourFaceFor, prepareStack } from "../tools/font-conformance.js";

/**
 * Blink's `LayoutLocale::LocaleForHan(content_locale)` (platform/text/
 * layout_locale.cc:226-257, Chromium 7d859f27) consults the renderer's
 * accept-languages BEFORE its default locale, and Windows asks it for every
 * unified-Han codepoint (win/font_fallback_win.cc:540-546 and
 * win/font_cache_skia_win.cc:92-121). In the headless shell the accept-languages
 * are the browser's `--accept-lang` switch and nothing else.
 *
 * Two launches differ only by `--accept-lang=ja`. On Windows the no-`lang` run
 * (`font-locale: auto`, a null content locale) and the explicit `lang="en"`
 * run must move from the default-locale answer to the Japanese one, exactly as
 * Chrome's `CSS.getPlatformFontsForNode` does. Elsewhere only the captured
 * decision is asserted: Linux passes `LocaleOrDefault()` to fontconfig and
 * macOS passes no locale, so neither consults this value.
 */
const flat = (tree: CapturedElement[]): CapturedElement[] => tree.flatMap((el) => [el, ...flat(el.children ?? [])]);
const W = 360,
  H = 160;
const HAN = 0x6f22; // 漢, Script=Han
const ids = ["auto", "en"] as const;
const html =
  '<!doctype html><meta charset="utf-8"><style>body{margin:0}' +
  "p{font:32px/44px Arial;margin:0}</style>" +
  '<p id="auto">漢字骨 auto</p><p id="en" lang="en">漢字骨 en</p>';

/** On Linux the application locale comes from the environment, not `--lang`
 * (`ui/base/l10n/l10n_util.cc:508-577`). */
const linuxEnv = { env: { ...process.env, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8", LANGUAGE: "en_US" } };

async function painted(page: Page, id: string): Promise<string[]> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument");
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: `#${id}` });
    const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
    return fonts.map((f) => f.postScriptName ?? f.familyName);
  } finally {
    await cdp.detach();
  }
}

function ourFace(el: CapturedElement, withAuthority: boolean): string | null {
  const lang = fontSelectionLanguage(el.styles);
  const stack = prepareStack(
    { fontFamily: "Arial", fontSize: 32, fontWeight: 400, fontStyle: "normal", fontStretch: "100%" },
    lang,
  );
  expect(stack).not.toBeNull();
  const ask = () => ourFaceFor(HAN, stack!, lang).postscriptName;
  return withAuthority ? withFontLocaleForHan(el.styles.fontLocaleForHan, ask) : ask();
}

const onWindows = process.platform === "win32" && isGlyphHelperAvailable();

describe("LocaleForHan accept-languages (DM-FEN1QP)", () => {
  it.each([
    ["--accept-lang=ja", "ja", { auto: "ja", en: "ja" }],
    [null, "", { auto: null, en: null }],
  ] as const)(
    "accept switch %s",
    async (accept, acceptLanguages, expected) => {
      const browser = await launchChromium({
        args: ["--lang=en-US", ...(accept != null ? [accept] : [])],
        ...(process.platform === "linux" ? linuxEnv : {}),
      });
      try {
        const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
        await page.setContent(html);
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        expect(await rendererDefaultLocaleForPage(page)).toEqual({ locale: "en-US" });
        expect(await browserAcceptLanguagesForPage(page)).toEqual({ acceptLanguages });
        // Playwright's `locale` is emulation: it changes navigator.languages, not
        // the renderer preference fonts read.
        const capture = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: W, height: H });
        const elements = flat(capture.tree);
        const owner = (id: string) => elements.find((el) => el.text.trim().endsWith(`骨 ${id}`))!;
        for (const id of ids) expect(owner(id).styles.fontLocaleForHan, id).toBe(expected[id]);

        if (!onWindows) return;
        const chrome = Object.fromEntries(await Promise.all(ids.map(async (id) => [id, await painted(page, id)])));
        const ours = Object.fromEntries(ids.map((id) => [id, ourFace(owner(id), true)]));
        const legacy = Object.fromEntries(ids.map((id) => [id, ourFace(owner(id), false)]));
        // Activation control: the paths-mode SVG must change when the authority
        // is dropped from the captured tree, and only where the answer moved.
        const without = structuredClone(capture.tree);
        for (const el of flat(without)) delete el.styles.fontLocaleForHan;
        const svg = withRenderTextMode("paths", () => elementTreeToSvg(capture.tree, W, H));
        const svgWithout = withRenderTextMode("paths", () => elementTreeToSvg(without, W, H));
        const directory = join(process.env.DOMOTION_OUTPUT_DIR ?? "tests/output", "han-accept-languages");
        await mkdir(directory, { recursive: true });
        await writeFile(
          join(directory, `${accept == null ? "none" : "ja"}.json`),
          JSON.stringify({ browser: browser.version(), chrome, ours, legacy, svgMoved: svg !== svgWithout }, null, 2),
        );
        for (const id of ids) expect(chrome[id], id).toContain(ours[id]);
        if (accept != null) {
          // Without the accept-language step the default (en-US) disambiguates
          // nothing, so the legacy route answers a different face than Chrome.
          for (const id of ids) expect(chrome[id], `${id} legacy`).not.toContain(legacy[id]);
          expect(svg).not.toBe(svgWithout);
        } else {
          expect(ours).toEqual(legacy);
          expect(svg).toBe(svgWithout);
        }
      } finally {
        await closeBrowserSafely(browser);
      }
    },
    120_000,
  );
});
