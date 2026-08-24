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

  it("crosses EffectiveZoom once for unitless linear points and keeps physical axes in vertical writing", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 620, height: 240 } });
    try {
      await page.setContent(`<style>
        html,body{margin:0}
        .g{position:absolute;top:15px;width:120px;height:40px;zoom:2}
        #horizontal{left:10px;background-image:-webkit-gradient(linear,12 8,80% 75%,from(red),to(blue))}
        #vertical{left:170px;writing-mode:vertical-rl;background-image:-webkit-gradient(linear,10% 25%,80% 75%,from(red),to(blue))}
      </style><div id="horizontal" class="g"></div><div id="vertical" class="g"></div>`);
      const computed = await page.locator("#horizontal").evaluate((element) => getComputedStyle(element).backgroundImage);
      expect(computed).toMatch(/-webkit-gradient\(linear, 12 8, 80% 75%/);
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 620, height: 240 });
      expect(tree[0]?.styles.backgroundImage).toMatch(/-webkit-gradient\(linear, 24 16, 80% 75%/);
      const svg = elementTreeToSvgInner(tree, 620, 240);
      expect(svg).toMatch(/<linearGradient[^>]+x1="44" y1="46" x2="212" y2="90"/);
      // Writing mode cannot swap the legacy physical width/height axes.
      expect(svg).toMatch(/<linearGradient[^>]+x1="364" y1="50" x2="532" y2="90"/);
    } finally { await page.close(); }
  });

  it("emits Blink's two radial circles and stable-sort-then-clamp stop domain", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 420, height: 220 } });
    try {
      await page.setContent(`<style>html,body{margin:0}#g{position:absolute;left:10px;top:15px;width:120px;height:40px;zoom:2;background-image:-webkit-gradient(radial,10 5,4,75% 80%,30,color-stop(1.2,yellow),to(blue),color-stop(-.2,lime),from(red))}</style><div id="g"></div>`);
      const computed = await page.locator("#g").evaluate((element) => getComputedStyle(element).backgroundImage);
      expect(computed).toMatch(/^-webkit-gradient\(radial, 10 5, 4, 75% 80%, 30/);
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 420, height: 220 });
      expect(tree[0]?.styles.backgroundImage).toMatch(/-webkit-gradient\(radial, 20 10, 8, 75% 80%, 60/);
      const svg = elementTreeToSvgInner(tree, 420, 220);
      expect(svg).toMatch(/<radialGradient[^>]+fx="40" fy="40" fr="8" cx="200" cy="94" r="60"/);
      expect([...svg.matchAll(/<stop offset="([^"]+)" stop-color="([^"]+)"/g)].map((match) => [Number(match[1]), match[2]]))
        .toEqual([[0, "rgb(0, 255, 0)"], [0, "rgb(255, 0, 0)"], [1, "rgb(0, 0, 255)"], [1, "rgb(255, 255, 0)"]]);
      expect(svg).not.toContain('spreadMethod="repeat"');
    } finally { await page.close(); }
  });

  it("leaves modern magic-corner and repeating-gradient routes unchanged", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 520, height: 180 } });
    try {
      await page.setContent(`<style>html,body{margin:0}.g{position:absolute;top:20px;width:240px;height:80px}#modern{left:10px;background:linear-gradient(to top right,red,blue)}#repeat{left:270px;background:repeating-linear-gradient(90deg,red 0 10px,blue 10px 20px)}</style><div id="modern" class="g"></div><div id="repeat" class="g"></div>`);
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 520, height: 180 });
      const svg = elementTreeToSvgInner(tree, 520, 180);
      expect(svg).toMatch(/<linearGradient[^>]+x1="106" y1="132" x2="154" y2="-12"/);
      expect(svg).toContain('spreadMethod="repeat"');
    } finally { await page.close(); }
  });
});
