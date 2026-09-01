import { afterAll, describe, expect, it } from "vitest";
import { launchChromium, captureElementTree, elementTreeToSvg, type CapturedElement } from "../src/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// DM-1271's old segment-raster workaround was superseded by DM-2467's
// source-owned generated-pseudo records. Keep the regression at the current
// ownership boundary: Blink supplies the exact ::after fragment and Domotion
// must render it directly without reviving the clipped legacy raster segment.

const W = 360, H = 120;
const HTML =
  `<!doctype html><html><head><meta charset="utf-8"><style>` +
  `body{margin:0}` +
  `div{padding:40px;background:#fff;font-family:system-ui,-apple-system,sans-serif;font-size:16px;line-height:normal}` +
  `a{color:#1d4ed8;text-decoration:none}` +
  `a[href$=".pdf"]::after{content:" 📄"}` +
  `</style></head><body><div><a href="report.pdf">Quarterly report</a></div></body></html>`;

function flatten(tree: CapturedElement[]): CapturedElement[] {
  return tree.flatMap((element) => [element, ...flatten(element.children ?? [])]);
}

async function setup() {
  try {
    return { browser: await launchChromium() };
  } catch {
    return null;
  }
}

const env = await setup();
afterAll(async () => {
  await closeBrowserSafely(env?.browser);
}, 15_000);

const describeBrowser = env ? describe : describe.skip;

describeBrowser("DM-1271: ::after color emoji keeps its source-owned overflow", () => {
  it("renders the exact Blink pseudo fragment without a legacy clipped raster", async () => {
    const { browser } = env!;
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    try {
      await page.setContent(HTML, { waitUntil: "load" });
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: W, height: H });
      const host = flatten(tree).find((element) => element.text.includes("Quarterly report"));
      const record = host?.pseudoFragments?.find((entry) => entry.pseudo === "::after");
      const fragment = record?.fragments.find((entry) => entry.kind === "text" && entry.text.includes("\u{1F4C4}"));
      expect(record?.status).toBe("exact");
      expect(fragment?.kind).toBe("text");
      if (fragment?.kind === "text") {
        expect(fragment.physicalRect.width).toBeGreaterThan(0);
        expect(fragment.physicalRect.height).toBeGreaterThan(0);
        expect(fragment.shapedInlineAdvance).toBeGreaterThan(0);
      }
      expect(host?.textSegments?.some((segment) => segment.text.includes("\u{1F4C4}"))).not.toBe(true);
      const svg = elementTreeToSvg(tree, W, H);
      expect(svg).toContain('data-domotion-pseudo="::after"');
      expect(svg).toContain('data-domotion-pseudo-owner="source-fragments"');
      expect(svg).toContain("\u{1F4C4}");
    } finally {
      await page.close();
    }
  }, 60_000);
});
