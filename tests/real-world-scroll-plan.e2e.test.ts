import type { Browser } from "@playwright/test";
import { afterAll, beforeAll, expect, it } from "vitest";
import sharp from "sharp";
import { launchChromium } from "../src/capture/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import { executeScrollPatternWithCapture } from "../src/scroll/executor.js";
import { composeScrollSvg } from "../src/scroll/composer.js";
import { parseScrollPattern } from "../src/scroll/pattern.js";
import { captureRealWorldScrollReference } from "./real-world-scroll-reference.js";
import { scrollChunkSeekTimeMs } from "./real-world-scroll-plan.js";

let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(async () => {
  await closeBrowserSafely(browser);
}, 15_000);

it("compares exact intermediate anchors and the visible terminal left limit without changing playback", async () => {
  const viewport = { width: 80, height: 80 };
  const page = await browser.newPage({ viewport });
  const output = await browser.newPage({ viewport });
  try {
    await page.setContent(
      `<!doctype html><style>body{margin:0}.panel{height:80px;position:relative}.mark{position:absolute;left:10px;top:10px;width:10px;height:10px;background:black}</style><div class="panel" style="background:red"><div class="mark"></div></div><div class="panel" style="background:lime"><div class="mark"></div></div><div class="panel" style="background:blue"><div class="mark"></div></div>`,
    );
    const references: Uint8Array[] = [];
    const segments = await executeScrollPatternWithCapture(
      page,
      parseScrollPattern("down:160px/2ms"),
      {
        viewportW: 80,
        viewportH: 80,
        prescroll: false,
        embedImages: false,
      },
      async (...args) => {
        const capture = await captureRealWorldScrollReference(...args);
        references.push(capture.debug.expectedPng);
        return capture;
      },
    );
    expect(segments.map((segment) => segment.scrollY)).toEqual([0, 80, 160]);
    const svg = composeScrollSvg(segments, { viewportW: 80, viewportH: 80, bgColor: "white" });
    await output.setContent(`<style>body{margin:0}</style>${svg}`);
    const cycleEnd = segments.at(-1)!.segmentEndMs;
    for (let index = 1; index < segments.length; index++) {
      const time = scrollChunkSeekTimeMs(segments[index].segmentEndMs, cycleEnd);
      await output.evaluate(async (currentTime) => {
        await Promise.all(
          document.getAnimations().map(async (animation) => {
            animation.pause();
            await animation.ready;
            animation.currentTime = currentTime;
          }),
        );
      }, time);
      const actual = await sharp(await output.screenshot())
        .removeAlpha()
        .raw()
        .toBuffer();
      const expected = await sharp(Buffer.from(references[index])).removeAlpha().raw().toBuffer();
      expect(actual).toEqual(expected);
    }
    // Only currentTime/pause changed: the infinite emitted timing is intact.
    expect(
      await output.evaluate(() =>
        document.getAnimations().every((animation) => animation.effect?.getTiming().iterations === Infinity),
      ),
    ).toBe(true);
    await output.evaluate((time) => {
      for (const animation of document.getAnimations()) animation.currentTime = time;
    }, cycleEnd);
    const wrapped = await sharp(await output.screenshot())
      .removeAlpha()
      .raw()
      .toBuffer();
    expect(wrapped).toEqual(await sharp(Buffer.from(references[0])).removeAlpha().raw().toBuffer());
  } finally {
    await page.close();
    await output.close();
  }
}, 30_000);

it.each([1, 2, 11_252, 1_000_000])(
  "preserves final cull visibility and endpoint CTM at a %s ms left limit",
  async (duration) => {
    const page = await browser.newPage({ viewport: { width: 80, height: 80 } });
    try {
      await page.setContent(
        `<style>@keyframes scroll{from{transform:translateY(0px)}to{transform:translateY(-3376px)}}@keyframes cull{0%{visibility:hidden}50%{visibility:visible}100%{visibility:hidden}}#stack{animation:scroll ${duration}ms linear infinite}#last{animation:cull ${duration}ms step-end infinite}</style><svg width="80" height="80"><g id="stack"><g id="last" transform="translate(0 3376)"><rect width="10" height="10"/></g></g></svg>`,
      );
      await page.evaluate(
        async (time) => {
          await Promise.all(
            document.getAnimations().map(async (animation) => {
              animation.pause();
              await animation.ready;
              animation.currentTime = time;
            }),
          );
        },
        scrollChunkSeekTimeMs(duration, duration),
      );
      expect(
        await page.locator("#last").evaluate((element) => ({
          y: (element as SVGGraphicsElement).getScreenCTM()?.f,
          visibility: getComputedStyle(element).visibility,
        })),
      ).toEqual({ y: 8, visibility: "visible" });
    } finally {
      await page.close();
    }
  },
);
