import { afterAll, describe, expect, it } from "vitest";
import { launchChromium } from "../src/index.js";
import {
  getFontInstance,
  resolveFontKey,
} from "../src/render/font-resolution.js";
import { isGlyphHelperAvailable, resolveInstalledFont } from "../src/render/glyph-helper.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// Browser-backed complement to the resolver regression test. Chromium is the
// authority for the painted PostScript member and Range width; Domotion must
// independently reach the same installed descriptor and advance. The source
// decision is FontFallbackIterator's declared-family-before-system order plus
// MatchFontFamily's exact returned CTFont (`font_fallback_iterator.cc:120-178`,
// `mac/font_matcher_mac.mm:591-705`, Chromium 7d859f271c).
async function setup() {
  if (process.platform !== "darwin" || !isGlyphHelperAvailable()) return null;
  try { return { browser: await launchChromium() }; } catch { return null; }
}

const env = await setup();
afterAll(async () => { await closeBrowserSafely(env?.browser); }, 15_000);
const describeMac = env == null ? describe.skip : describe;

async function chromeFaceAndWidths(family: string, text: string) {
  const page = await env!.browser.newPage({ viewport: { width: 400, height: 120 } });
  try {
    await page.setContent("<!doctype html><main></main>");
    await page.locator("main").evaluate((main, input) => {
      const span = document.createElement("span");
      span.id = "probe";
      span.textContent = input.text;
      span.style.fontFamily = `"${input.family}", Times`;
      span.style.fontSize = "32px";
      main.append(span);
    }, { family, text });
    // CSS.getPlatformFontsForNode reports only faces used by a completed
    // layout. Force the range through layout before asking CDP; without this,
    // a newly-appended astral-only run can legitimately return an empty list.
    await page.locator("#probe").evaluate((span) => span.getBoundingClientRect());
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument");
    const { nodeId } = await cdp.send("DOM.querySelector", {
      nodeId: root.nodeId, selector: "#probe",
    });
    const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
    const widths = await page.locator("#probe").evaluate((span) => {
      const node = span.firstChild!;
      const result: number[] = [];
      let start = 0;
      for (const scalar of span.textContent ?? "") {
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, start + scalar.length);
        result.push(range.getBoundingClientRect().width);
        start += scalar.length;
      }
      return result;
    });
    return { postscriptName: fonts[0]?.postScriptName ?? null, widths };
  } finally {
    await page.close();
  }
}

function domotionFaceAndWidths(family: string, cps: number[]) {
  const key = resolveFontKey(`"${family}", Times`);
  const font = getFontInstance(key, 400, 32, 0);
  if (font == null) throw new Error(`Domotion could not open ${family} (${key})`);
  return {
    key,
    postscriptName: font.instantiatedPostscriptName ?? font.postscriptName ?? null,
    widths: cps.map((cp) => (font.glyphForCodePoint(cp).advanceWidth ?? 0) / font.unitsPerEm * 32),
  };
}

describeMac("macOS named-family identity against Chromium", () => {
  it("matches Hiragino Kaku Gothic ProN by face and advance", async () => {
    const chrome = await chromeFaceAndWidths("Hiragino Kaku Gothic ProN", "🄀🄜");
    const ours = domotionFaceAndWidths("Hiragino Kaku Gothic ProN", [0x1f100, 0x1f11c]);
    expect(chrome.postscriptName).toBe("HiraKakuProN-W3");
    expect(ours.key).toBe("sysfb:HiraKakuProN-W3");
    expect(ours.postscriptName).toBe(chrome.postscriptName);
    expect(ours.widths).toEqual(chrome.widths);
  });

  it("matches the installed SF Pro Text optical face by face and advance", async () => {
    if (resolveInstalledFont("SF Pro Text")?.postscriptName !== "SFProText-Regular") return;
    const chrome = await chromeFaceAndWidths("SF Pro Text", "Ɫⱥ");
    const ours = domotionFaceAndWidths("SF Pro Text", [0x2c62, 0x2c65]);
    expect(chrome.postscriptName).toBe("SFProText-Regular");
    expect(ours.key).toBe("sysfb:SFProText-Regular");
    expect(ours.postscriptName).toBe(chrome.postscriptName);
    expect(ours.widths).toEqual(chrome.widths);
  });
});
