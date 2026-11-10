import type { Browser, Page } from "@playwright/test";
import { isGlyphHelperAvailable } from "@domotion/text-engine/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { launchChromium } from "../src/capture/index.js";
import {
  clearWebfonts,
  getFontInstance,
  isolatedPrimaryFontMetrics,
  registerWebfont,
  resolveFontKey,
} from "../src/render/font-resolution.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import { FIXTURE_FONT_CSS, FIXTURE_MONO_FAMILY, registerFixtureFonts } from "./fixture-fonts.js";

let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(async () => closeBrowserSafely(browser), 15_000);
afterEach(() => clearWebfonts());

async function paintedFace(page: Page) {
  const width = await page.locator("#probe").evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    return range.getBoundingClientRect().width;
  });
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("DOM.enable");
    await session.send("CSS.enable");
    const { root } = await session.send("DOM.getDocument");
    const { nodeId } = await session.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#probe" });
    const { fonts } = await session.send("CSS.getPlatformFontsForNode", { nodeId });
    expect(fonts).toHaveLength(1);
    return { width, face: fonts[0] };
  } finally {
    await session.detach();
  }
}

describe.skipIf(process.platform !== "darwin" || !isGlyphHelperAvailable())("macOS installed-family visibility", () => {
  it.each(["SF Pro", ".SF NS", ".SFNS-Regular", "Menlo"])(
    "matches the face Chromium paints for literal %s",
    async (family) => {
      const page = await browser.newPage();
      try {
        const stack = `${JSON.stringify(family)}, Times`;
        await page.setContent(`<span id="probe" style='font:20px ${stack}'>0</span>`);
        const native = await paintedFace(page);
        const font = getFontInstance(resolveFontKey(stack), 400, 20, 0);
        expect(font).not.toBeNull();
        expect(font!.postscriptName).toBe(native.face.postScriptName);
        const advance = (font!.glyphForCodePoint(0x30).advanceWidth! / font!.unitsPerEm) * 20;
        expect(Math.abs(advance - native.width)).toBeLessThanOrEqual(1 / 64);
        if (family.startsWith(".")) expect(native.face.postScriptName).toBe("Times-Roman");
      } finally {
        await page.close();
      }
    },
  );
  it.each(["system-ui", "BlinkMacSystemFont"])("preserves the %s UI-font route", async (family) => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<span id="probe" style="font:20px ${family}">0</span>`);
      const native = await paintedFace(page);
      expect(native.face.postScriptName).toBe(".SFNS-Regular");
      expect(getFontInstance(resolveFontKey(family), 400, 20, 0)?.postscriptName).toBe(native.face.postScriptName);
    } finally {
      await page.close();
    }
  });
  it.each(["SF Pro", ".SF NS"])("matches normal line spacing for literal %s at actual CSS sizes", async (family) => {
    const page = await browser.newPage();
    try {
      for (const size of [9, 13, 20, 72]) {
        const stack = `${JSON.stringify(family)}, Times`;
        await page.setContent(`<div id="probe" style='font:${size}px ${stack};height:100lh'></div>`);
        const height = await page.locator("#probe").evaluate((node) => node.getBoundingClientRect().height);
        const metrics = isolatedPrimaryFontMetrics({
          fontFamily: stack,
          fontSize: size,
          fontWeight: 400,
          italic: false,
        });
        expect(metrics?.lineSpacing, `${family} at ${size}px`).toBe(height / 100);
      }
    } finally {
      await page.close();
    }
  });
});

it.each(["SF Pro", ".SF NS"])("keeps registered author bytes named %s above installed visibility", async (family) => {
  const mono = /base64,([^"\s]+)/.exec(FIXTURE_FONT_CSS)?.[1];
  if (mono == null) throw new Error("Missing deterministic mono fixture");
  registerWebfont(family, 400, "normal", Buffer.from(mono, "base64"));
  const page = await browser.newPage();
  try {
    const stack = `${JSON.stringify(family)}, Times`;
    await page.setContent(
      `<style>${FIXTURE_FONT_CSS.replaceAll(FIXTURE_MONO_FAMILY, family)}</style><span id="probe" style='font:20px ${stack}'>0</span>`,
    );
    await page.evaluate(() => document.fonts.ready);
    const native = await paintedFace(page);
    expect(native.face.isCustomFont).toBe(true);
    const key = resolveFontKey(stack);
    expect(key).toBe(`webfont:${family.toLowerCase()}`);
    const font = getFontInstance(key, 400, 20, 0);
    expect(font?.postscriptName).toBe(native.face.postScriptName);
    const advance = (font!.glyphForCodePoint(0x30).advanceWidth! / font!.unitsPerEm) * 20;
    expect(Math.abs(advance - native.width)).toBeLessThanOrEqual(1 / 64);
  } finally {
    await page.close();
  }
});

it("matches native SF Pro availability before a registered fallback on every platform", async () => {
  registerFixtureFonts();
  const page = await browser.newPage();
  try {
    const stack = `"SF Pro", "${FIXTURE_MONO_FAMILY}"`;
    await page.setContent(`<style>${FIXTURE_FONT_CSS}</style><span id="probe" style='font:20px ${stack}'>0</span>`);
    await page.evaluate(() => document.fonts.ready);
    const native = await paintedFace(page);
    const key = resolveFontKey(stack);
    const font = getFontInstance(key, 400, 20, 0);
    expect(font?.postscriptName).toBe(native.face.postScriptName);
    if (native.face.isCustomFont) expect(key).toBe(`webfont:${FIXTURE_MONO_FAMILY.toLowerCase()}`);
    else expect(key).not.toBe("sf-pro");
  } finally {
    await page.close();
  }
});
