import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, BrowserContextOptions, Page } from "@playwright/test";
import sharp from "sharp";
import { captureElementTree, elementTreeToSvg, launchChromium } from "../src/index.js";
import { probeImageDocumentSettings } from "../src/capture/image-document-settings.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// An <img> SVG document copies prefersReducedMotion / inForcedColors from the
// renderer's first ordinary page's Settings (svg_image.cc:901-904,
// isolated_svg_document_host.cc:192-199, chromium 7d859f27) and sees no media
// overrides. These tests hold the capture-time oracle to a real <img> paint in
// configurations where the page's matchMedia gives the opposite answer.
//
// The image's prefers-reduced-motion follows the host OS preference, which is
// not fixed: GitHub's hosted macOS runners report reduce, a typical dev Mac does
// not. So the reduced-motion expectation of the cases that do not force it is
// the host's own answer, measured from a real <img> paint with no emulation.

const W = 120;
const H = 80;
const svgImg = (query: string): string =>
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30"><style>rect { fill: rgb(220, 0, 0) } @media ${query} { rect { fill: rgb(0, 0, 220) } }</style><rect width="30" height="30"/></svg>`,
  );
const QUERIES = ["(prefers-reduced-motion: reduce)", "(forced-colors: active)"] as const;
const HTML = `<!doctype html><body style="margin:0;background:#fff">${QUERIES.map(
  (q, i) =>
    `<img alt="" src="${svgImg(q)}" style="position:absolute;left:${5 + i * 40}px;top:5px;width:30px;height:30px">`,
).join("")}</body>`;

/** Whether each img (at its center) painted the query's blue branch. */
async function blueAt(png: Buffer): Promise<boolean[]> {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  return QUERIES.map((_, i) => {
    const k = (20 * info.width + 20 + i * 40) * info.channels;
    return data[k + 2] > 128 && data[k] < 128;
  });
}

const browsers: Browser[] = [];
afterAll(async () => {
  for (const browser of browsers) await closeBrowserSafely(browser);
}, 60_000);

async function openPage(args: string[], context: BrowserContextOptions): Promise<Page> {
  const browser = await launchChromium({ args });
  browsers.push(browser);
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, ...context });
  const page = await ctx.newPage();
  await page.setContent(HTML, { waitUntil: "load" });
  return page;
}

describe("<img> SVG document Settings (prefers-reduced-motion / forced-colors)", () => {
  const cases: Array<{
    name: string;
    args: string[];
    context: BrowserContextOptions;
    /** The page's own matchMedia("(prefers-reduced-motion: reduce)"). */
    pageReduce: boolean;
    /** The image's [reduced-motion, forced-colors] answers; "host" = the host OS preference. */
    expected: ["host" | boolean, boolean];
    capture: boolean;
  }> = [
    // A reducedMotion emulation is a page media override: the page matches
    // reduce, the image does not.
    {
      name: "emulated reduce",
      args: [],
      context: { reducedMotion: "reduce" },
      pageReduce: true,
      expected: ["host", false],
      capture: true,
    },
    // The browser-wide preference reaches Settings while Playwright's default
    // no-preference emulation keeps the page's matchMedia false. A default
    // renderer would take the other branch of a live query, so this case
    // discriminates in pixels.
    {
      name: "forced reduced-motion preference",
      args: ["--force-prefers-reduced-motion"],
      context: {},
      pageReduce: false,
      expected: [true, false],
      capture: true,
    },
    // forcedColors emulation writes the page's Settings
    // (inspector_emulation_agent.cc:418-430), which the image copies.
    {
      name: "emulated forced colors",
      args: [],
      context: { forcedColors: "active" },
      pageReduce: false,
      expected: ["host", true],
      capture: true,
    },
  ];
  let hostReduce = false;
  beforeAll(async () => {
    // Playwright's default emulation is a page media override, which the image
    // never sees, so an un-emulated page's <img> paint is the host preference.
    const page = await openPage([], {});
    [hostReduce] = await blueAt(await page.screenshot({ clip: { x: 0, y: 0, width: W, height: H } }));
  }, 60_000);

  for (const c of cases) {
    it(`agrees with a real <img> paint: ${c.name}`, async () => {
      const expected: [boolean, boolean] = [c.expected[0] === "host" ? hostReduce : c.expected[0], c.expected[1]];
      const page = await openPage(c.args, c.context);
      expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(c.pageReduce);
      const painted = await blueAt(await page.screenshot({ clip: { x: 0, y: 0, width: W, height: H } }));
      expect(painted).toEqual(expected);
      const oracle = await probeImageDocumentSettings(page);
      expect(oracle).toEqual({ prefersReducedMotion: expected[0], forcedColors: expected[1] });
      if (!c.capture) return;

      // Capture freezes the image's own answer in the output sheet, which then
      // paints the same branch in a renderer with default settings.
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: W, height: H });
      const svg = elementTreeToSvg(tree, W, H);
      expect(svg).not.toMatch(/prefers-reduced-motion|forced-colors/);
      const rasterBrowser = await launchChromium();
      try {
        const raster = await rasterBrowser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
        await raster.setContent(`<!doctype html><body style="margin:0">${svg}</body>`, { waitUntil: "load" });
        expect(await blueAt(await raster.screenshot({ clip: { x: 0, y: 0, width: W, height: H } }))).toEqual(expected);
      } finally {
        await closeBrowserSafely(rasterBrowser);
      }
    }, 60_000);
  }
});
