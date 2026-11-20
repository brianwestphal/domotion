// A kStandardFamily element (no declared font-family) resolves its primary
// font through `settings.Standard(script)` with the element's locale
// (`FontSelector::FamilyNameFromSettings`, platform/fonts/font_selector.cc,
// Chromium 7d859f27). Capture used to measure the baseline ascent with a
// detached canvas asking for the computed settings NAME ("Times" on macOS), so
// `lang=ja` text painted in the Japanese standard face sat one pixel low. The
// same canvas could not see a generic keyword's locale either. Capture now
// measures those descriptions with a DOM probe carrying the element's own
// family type and `-webkit-locale`.
import type { Browser, Page } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureElementTree, launchChromium } from "../src/capture/index.js";
import type { CapturedElement } from "../src/capture/types.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import { withRenderTextMode } from "../src/render/font-resolution.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

const W = 240;
const H = 56;
let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(async () => closeBrowserSafely(browser), 15_000);

const flat = (nodes: CapturedElement[]): CapturedElement[] => nodes.flatMap((n) => [n, ...flat(n.children)]);

async function rgba(png: Buffer): Promise<Buffer> {
  return sharp(png).ensureAlpha().raw().toBuffer();
}

/** The element's own Blink metrics: a baseline-aligned zero-size inline-block inside it. */
async function nativeMetrics(page: Page): Promise<{ ascent: number; descent: number }> {
  return page.locator("p").evaluate((p) => {
    const probe = document.createElement("span");
    probe.textContent = "M";
    const mark = document.createElement("span");
    mark.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline";
    p.append(probe, mark);
    const t = probe.getBoundingClientRect();
    const m = mark.getBoundingClientRect();
    probe.remove();
    mark.remove();
    return { ascent: m.top - t.top, descent: t.bottom - m.top };
  });
}

async function run(style: string, lang: string | null) {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  try {
    await page.setContent(
      `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:white}p{margin:0;font-size:32px;line-height:48px;${style}}</style><p${lang == null ? "" : ` lang="${lang}"`}>ABC漢字</p>`,
    );
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const metrics = await nativeMetrics(page);
    const native = await page.screenshot();
    const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: W, height: H });
    const p = flat(tree).find((n) => n.tag === "p")!;
    const svg = withRenderTextMode("embedded-font", () => elementTreeToSvg(tree, W, H));
    await page.setContent(`<body style="margin:0;background:white">${svg}`);
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const output = await page.screenshot();
    const a = await rgba(native);
    const b = await rgba(output);
    let pixels = 0;
    for (let i = 0; i < a.length; i += 4) if (!a.subarray(i, i + 4).equals(b.subarray(i, i + 4))) pixels++;
    return { metrics, captured: { ascent: p.fontAscent, descent: p.fontDescent }, pixels, p };
  } finally {
    await page.close();
  }
}

describe("standard/generic family metrics follow the element's locale", () => {
  it("captures the Japanese standard face's ascent for undeclared lang=ja text", async () => {
    const result = await run("", "ja");
    expect(result.p.styles.fontFamilyStack?.genericFamily).toBe("standard");
    expect(result.captured).toEqual(result.metrics);
    if (process.platform === "darwin") {
      // Hiragino Kaku Gothic ProN at 32px (Times would be 29 / 8).
      expect(result.metrics).toEqual({ ascent: 28, descent: 4 });
      expect(result.pixels).toBe(0);
    }
  });

  it("captures a generic keyword's locale-keyed face", async () => {
    const result = await run("font-family:serif", "ja");
    expect(result.captured).toEqual(result.metrics);
    if (process.platform === "darwin") expect(result.pixels).toBe(0);
  });

  it("negative control: a literal family keeps its own metrics under lang=ja", async () => {
    const result = await run("font-family:Times", "ja");
    expect(result.captured).toEqual(result.metrics);
    if (process.platform === "darwin") expect(result.metrics).toEqual({ ascent: 29, descent: 8 });
  });

  it("negative control: undeclared text without a language is unchanged", async () => {
    const result = await run("", null);
    expect(result.captured).toEqual(result.metrics);
    if (process.platform === "darwin") expect(result.pixels).toBe(0);
  });
});
