import { afterAll, describe, expect, it } from "vitest";
import { captureElementTree, elementTreeToSvgInner, launchChromium } from "../src/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

const env = await (async () => { try { return { browser: await launchChromium() }; } catch { return null; } })();
afterAll(async () => { await closeBrowserSafely(env?.browser); }, 15_000);
const describeBrowser = env ? describe : describe.skip;

describeBrowser("legacy -webkit-gradient endpoint geometry", () => {
  it("preserves Chromium's explicit diagonal endpoints on a non-square background", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 360, height: 180 } });
    try {
      await page.setContent(`<style>html,body{margin:0}#g{position:absolute;left:20px;top:30px;width:240px;height:80px;background-image:-webkit-gradient(linear,10% 25%,80% 75%,from(red),color-stop(.35,lime),to(blue))}</style><div id="g"></div>`);
      const computed = await page.locator("#g").evaluate((element) => getComputedStyle(element).backgroundImage);
      expect(computed).toMatch(/^-webkit-gradient\(linear, 10% 25%, 80% 75%/);
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 360, height: 180 });
      const svg = elementTreeToSvgInner(tree, 360, 180);
      expect(svg).toMatch(/<linearGradient[^>]+x1="44" y1="50" x2="212" y2="90"/);
      expect(svg).toMatch(/<stop offset="0(?:\.0+)?"[^>]+\/><stop offset="0\.35"/);
    } finally { await page.close(); }
  });
});
