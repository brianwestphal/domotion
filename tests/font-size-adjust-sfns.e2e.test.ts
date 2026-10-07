import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { captureElementTree, elementTreeToSvg, launchChromium } from "../src/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

const WIDTH = 320;
const HEIGHT = 100;
const env = await (async () => {
  try {
    return { browser: await launchChromium() };
  } catch {
    return null;
  }
})();
afterAll(async () => closeBrowserSafely(env?.browser), 15_000);
const describeMacBrowser = process.platform === "darwin" && env != null ? describe : describe.skip;

async function inkBounds(png: Buffer): Promise<{ left: number; right: number }> {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let left = info.width;
  let right = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const offset = (y * info.width + x) * info.channels;
      if (data[offset] < 200 && data[offset + 1] < 200 && data[offset + 2] < 200) {
        left = Math.min(left, x);
        right = Math.max(right, x);
      }
    }
  }
  return { left, right };
}

describeMacBrowser("macOS SFNS font-size-adjust rendering", () => {
  it.each(["paths", "embedded-font"] as const)(
    "keeps adjusted ink geometry in %s mode",
    async (renderTextMode) => {
      const page = await env!.browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
      const svgPage = await env!.browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
      try {
        await page.setContent(
          `<div id="root" style="box-sizing:border-box;width:${WIDTH}px;height:${HEIGHT}px;background:white;padding:16px">` +
            `<span style="font:400 16px system-ui;font-size-adjust:0.8;color:black">MMMMxxxx</span></div>`,
        );
        const expected = await page.locator("#root").screenshot();
        const tree = await captureElementTree(page, "#root", { x: 0, y: 0, width: WIDTH, height: HEIGHT });
        const svg = elementTreeToSvg(tree, WIDTH, HEIGHT, { renderTextMode });
        await svgPage.setContent(
          `<img alt="rendered" src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}">`,
        );
        const actual = await svgPage.locator("img").screenshot();
        const evidenceDir = process.env.DM_GMZYRW_EVIDENCE_DIR;
        if (evidenceDir != null) {
          await mkdir(evidenceDir, { recursive: true });
          await Promise.all([
            writeFile(join(evidenceDir, "chromium.png"), expected),
            writeFile(join(evidenceDir, `${renderTextMode}.png`), actual),
            writeFile(join(evidenceDir, `${renderTextMode}.svg`), svg),
          ]);
        }
        const expectedInk = await inkBounds(expected);
        const actualInk = await inkBounds(actual);
        expect(expectedInk.right - expectedInk.left).toBeGreaterThan(120);
        expect(Math.abs(actualInk.left - expectedInk.left)).toBeLessThanOrEqual(2);
        expect(Math.abs(actualInk.right - expectedInk.right)).toBeLessThanOrEqual(2);
      } finally {
        await page.close();
        await svgPage.close();
      }
    },
    60_000,
  );
});
