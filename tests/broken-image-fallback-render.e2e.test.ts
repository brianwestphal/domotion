import { afterAll, describe, expect, it } from "vitest";
import sharp from "sharp";

import {
  captureElementTreeWithWarnings,
  elementTreeToSvg,
  launchChromium,
  type CapturedElement,
} from "../src/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

const BROKEN = "data:image/png;base64,AAAA";
const GOOD = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const WIDTH = 760;
const HEIGHT = 360;

function flatten(nodes: CapturedElement[]): CapturedElement[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children ?? [])]);
}

async function meanAbsoluteError(left: Buffer, right: Buffer): Promise<number> {
  const [a, b] = await Promise.all([
    sharp(left).removeAlpha().raw().toBuffer(),
    sharp(right).removeAlpha().raw().toBuffer(),
  ]);
  expect(b.length).toBe(a.length);
  let total = 0;
  for (let index = 0; index < a.length; index++) total += Math.abs(a[index] - b[index]);
  return total / a.length;
}

const env = await (async () => {
  try { return { browser: await launchChromium() }; } catch { return null; }
})();
afterAll(async () => closeBrowserSafely(env?.browser), 15_000);
const describeBrowser = env == null ? describe.skip : describe;

describeBrowser("hybrid broken-image fallback renderer (DM-2464)", () => {
  for (const dpr of [1, 2]) {
    it(`keeps Chromium icon pixels raster and alternative text vector at DPR ${dpr}`, async () => {
      const context = await env!.browser.newContext({
        viewport: { width: WIDTH, height: HEIGHT },
        deviceScaleFactor: dpr,
      });
      const source = await context.newPage();
      const generated = await context.newPage();
      try {
        await source.setContent(`<!doctype html><style>
          html,body{margin:0;width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden;background:white}
          #stage{position:relative;width:${WIDTH}px;height:${HEIGHT}px;background:white;color:rgb(23,34,45);font:18px/26px Arial,sans-serif}
          img{position:absolute}
          #ltr{left:12px;top:12px;font-style:italic;font-weight:700}
          #title{left:12px;top:58px}
          #missing{left:12px;top:104px}
          #empty{left:12px;top:150px}
          #small{left:50px;top:150px;width:17px;height:17px}
          #threshold{left:90px;top:150px;width:18px;height:18px}
          #rtl{left:150px;top:12px;direction:rtl;color:rgb(70,20,120)}
          #vertical{left:305px;top:12px;writing-mode:vertical-rl;color:rgb(10,90,55)}
          #zoom{left:420px;top:12px;zoom:1.5;color:rgb(120,35,20)}
          #author{left:420px;top:110px;border:3px solid rgb(20,70,130);padding:4px 7px;background:rgb(235,242,252);color:rgb(15,45,75)}
          #good{left:680px;top:12px;width:24px;height:24px;image-rendering:pixelated}
        </style><div id="stage">
          <img id="ltr" src="${BROKEN}" alt="A😀 fallback">
          <img id="title" src="${BROKEN}" title="Title fallback">
          <img id="missing" src="${BROKEN}">
          <img id="empty" src="${BROKEN}" alt="">
          <img id="small" src="${BROKEN}" alt="">
          <img id="threshold" src="${BROKEN}" alt="">
          <img id="rtl" src="${BROKEN}" alt="مرحبا">
          <img id="vertical" src="${BROKEN}" alt="縦書き">
          <img id="zoom" src="${BROKEN}" alt="Zoom">
          <img id="author" src="${BROKEN}" alt="Author box">
          <img id="good" src="${GOOD}" alt="successful">
        </div>`, { waitUntil: "load" });
        await source.evaluate(() => document.fonts.ready);
        const expected = await source.screenshot();
        const capture = await captureElementTreeWithWarnings(
          source,
          "#stage",
          { x: 0, y: 0, width: WIDTH, height: HEIGHT },
        );
        expect(capture.warnings.filter(({ feature }) => feature === "broken-image-fallback")).toEqual([]);
        const images = flatten(capture.tree).filter((node) => node.tag === "img");
        expect(images).toHaveLength(11);
        const records = images.map((image) => image.brokenImageFallback!);
        const visibleIcons = records.filter((record) => record.icon?.visible === true);
        const hiddenIcons = records.filter((record) => record.icon?.visible === false);
        expect(visibleIcons.length).toBeGreaterThan(5);
        expect(visibleIcons.every((record) => record.icon?.raster?.source === "chromium-isolated-ua-shadow-icon-v1")).toBe(true);
        expect(visibleIcons.every((record) => record.icon?.raster?.rgbaSha256.length === 64)).toBe(true);
        expect(visibleIcons.every((record) => record.icon?.raster?.pngSha256.length === 64)).toBe(true);
        const ltr = records.find((record) => record.source.resolvedText === "A😀 fallback")!;
        expect(ltr.icon?.resourceScale).toBe(dpr === 1 ? 1 : 2);
        expect(ltr.icon?.raster).toMatchObject({ pixelWidth: 16 * dpr, pixelHeight: 16 * dpr });
        const zoom = records.find((record) => record.source.resolvedText === "Zoom")!;
        expect(zoom.icon?.raster).toMatchObject({ pixelWidth: 24 * dpr, pixelHeight: 24 * dpr });
        expect(hiddenIcons.every((record) => record.icon?.raster == null)).toBe(true);
        const ordinary = records.find((record) => record.loadState === "loaded")!;
        expect(ordinary).toMatchObject({ disposition: "primary", paintOwnership: "none" });
        expect(ordinary.icon).toBeUndefined();

        const svg = elementTreeToSvg(capture.tree, WIDTH, HEIGHT);
        expect(svg.match(/data-broken-image-icon=/g)).toHaveLength(visibleIcons.length);
        expect(svg).not.toContain("<polyline");
        // The normal text route may choose outlined `<use>` glyphs or its
        // embedded subset-font `<text>` mode. It must never emit authored
        // alternative text in the old raw host-font element.
        expect(svg).toMatch(/font-family="dmf\d+"/);
        expect(svg).not.toMatch(/<text\b[^>]*>Title fallback<\/text>/);
        const vectorTextRecords = records.filter((record) => (record.text?.segments.length ?? 0) > 0);
        expect(svg.match(/data-broken-image-text="vector"/g)).toHaveLength(vectorTextRecords.length);
        // The vertical record used to disappear at renderer dispatch because
        // its UA-shadow segments lacked per-character UAX #50 orientation.
        expect(records.find((record) => record.source.resolvedText === "縦書き")?.text?.segments.every(
          (segment) => segment.verticalOrientations != null,
        )).toBe(true);
        expect(svg).toContain('aria-label="Title fallback"');
        expect(svg).toContain('aria-hidden="true"');
        // The ordinary successful image remains independent of the icon
        // payloads; image-hoisting may represent repeated icon rasters as
        // `<use>` references, so ownership is asserted by the marker above.
        expect(svg).toContain(GOOD);

        await generated.setContent(`<style>html,body{margin:0;width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden;background:white}</style>${svg}`);
        await generated.evaluate(() => document.fonts.ready);
        await generated.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
        const axSession = await generated.context().newCDPSession(generated);
        await axSession.send("Accessibility.enable");
        const axTree = await axSession.send("Accessibility.getFullAXTree");
        const titleAx = axTree.nodes.filter((node) => node.role?.value === "image" && node.name?.value === "Title fallback");
        expect(titleAx).toHaveLength(1);
        const actual = await generated.screenshot();
        // Text outlines are independently shaped by Domotion, while every icon
        // pixel is the exact isolated Chromium crop. Keep this integration
        // guard intentionally broad; DM-2465 owns the tight platform oracle.
        expect(await meanAbsoluteError(expected, actual)).toBeLessThan(7);
      } finally {
        await context.close();
      }
    }, 60_000);
  }
});
