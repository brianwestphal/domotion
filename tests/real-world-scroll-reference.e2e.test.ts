import { chromium } from "@playwright/test";
import { afterAll, expect, it } from "vitest";
import sharp from "sharp";
import { withTimeout } from "../src/utils/with-timeout.js";
import { freezeRealWorldDom } from "./real-world-dom-freeze.js";
import { captureRealWorldScrollReference } from "./real-world-scroll-reference.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import { executeScrollPatternWithCapture } from "../src/scroll/executor.js";
import { parseScrollPattern } from "../src/scroll/pattern.js";
import { elementTreeToSvgInner } from "../src/render/element-tree-to-svg.js";

const browser = await chromium.launch();
afterAll(async () => closeBrowserSafely(browser), 15_000);

it.each([0, 0.5, 1])(
  "retains scroll-triggered wordmark opacity %s in source and output",
  async (opacity) => {
    const viewport = { width: 320, height: 200 };
    const page = await browser.newPage({ viewport });
    const output = await browser.newPage({ viewport });
    try {
      await page.setContent(`<style>body{margin:0;background:black}#spacer{height:400px}
      #wordmark{opacity:0;height:100px}svg{display:block;width:320px;height:100px}</style>
      <div id="spacer"></div><div id="wordmark"><svg viewBox="0 0 320 100"><path fill="white" d="M20 20H300V80H20Z"/></svg></div>
      <div style="height:100px"></div>
      <script>
        addEventListener('scroll',()=>{
          if(window.scrollY>0&&!window.entered){
            window.entered=true;
            const animation=document.querySelector('#wordmark').animate([{opacity:0},{opacity:1}],{duration:100000,fill:'both'});
            animation.pause();animation.currentTime=${opacity * 100000};
          }
        });
      </script>`);
      await page.evaluate(() => window.scrollTo(0, 400));
      await page.waitForFunction(() => document.getAnimations().length === 1);
      const capture = await captureRealWorldScrollReference(page, "body", { x: 0, y: 0, ...viewport });
      const png = Buffer.from(capture.debug.expectedPng);
      const sampled = await sharp(png).raw().toBuffer({ resolveWithObject: true });
      const pixel = sampled.data[(50 * sampled.info.width + 50) * sampled.info.channels];
      expect(pixel).toBeCloseTo(opacity * 255, -0.1);
      expect(await page.locator("#wordmark").evaluate((el) => Number(getComputedStyle(el).opacity))).toBe(opacity);

      const inner = await elementTreeToSvgInner(capture.tree, viewport.width, viewport.height);
      await output.setContent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="320" height="200" fill="black"/>${inner}</svg>`,
      );
      await output.addStyleTag({ content: "body{margin:0}" });
      const actual = await sharp(await output.screenshot())
        .raw()
        .toBuffer({ resolveWithObject: true });
      // Chromium quantizes group opacity and SVG opacity one byte apart at 0.5.
      expect(Math.abs(actual.data[(50 * actual.info.width + 50) * actual.info.channels] - pixel)).toBeLessThanOrEqual(
        1,
      );

      // The old reference path finishes this finite animation even though it is paused.
      await page.screenshot({ animations: "disabled" });
      expect(await page.locator("#wordmark").evaluate((el) => Number(getComputedStyle(el).opacity))).toBe(1);
      // Retained source bytes still describe the captured anchor, even after later scroll work.
      expect(Buffer.from(capture.debug.expectedPng)).toEqual(png);
    } finally {
      await page.close();
      await output.close();
    }
  },
  30_000,
);

it("pairs each executor anchor with its capture-time reference and propagates evidence failures", async () => {
  const page = await browser.newPage({ viewport: { width: 320, height: 200 } });
  try {
    await page.setContent(
      '<!doctype html><style>body{margin:0}</style><div style="height:800px;background:linear-gradient(red,blue)"></div>',
    );
    const references: Array<{ y: number; png: Uint8Array }> = [];
    const segments = await executeScrollPatternWithCapture(
      page,
      parseScrollPattern("down:400px/1ms"),
      {
        viewportW: 320,
        viewportH: 200,
        prescroll: false,
        embedImages: false,
      },
      async (...args) => {
        const captured = await captureRealWorldScrollReference(...args);
        references.push({ y: await page.evaluate(() => scrollY), png: captured.debug.expectedPng });
        return captured;
      },
    );
    expect(segments.map((segment) => segment.scrollY)).toEqual([0, 200, 400]);
    expect(references.map((reference) => reference.y)).toEqual(segments.map((segment) => segment.scrollY));
    expect(references.every((reference) => reference.png.length > 0)).toBe(true);
    const anchorRed = await Promise.all(
      references.map(async (reference) => {
        const image = await sharp(Buffer.from(reference.png)).raw().toBuffer({ resolveWithObject: true });
        return image.data[(50 * image.info.width + 50) * image.info.channels];
      }),
    );
    expect(anchorRed[0]).toBeGreaterThan(anchorRed[1]);
    expect(anchorRed[1]).toBeGreaterThan(anchorRed[2]);
    await expect(
      executeScrollPatternWithCapture(
        page,
        parseScrollPattern("down:1px/1ms"),
        {
          viewportW: 320,
          viewportH: 200,
          prescroll: false,
          embedImages: false,
        },
        async () => {
          throw new Error("reference failed");
        },
      ),
    ).rejects.toThrow("reference failed");
  } finally {
    await page.close();
  }
}, 30000);

it("pauses running animations in the page and child frame without seeking", async () => {
  const page = await browser.newPage({ viewport: { width: 320, height: 200 } });
  try {
    await page.setContent(
      '<!doctype html><div id="paint">paint</div><iframe srcdoc="<div id=paint>child</div>"></iframe>',
    );
    await page.frames()[1].waitForSelector("#paint");
    for (const frame of page.frames()) {
      await frame.evaluate(() => {
        const animation = document.querySelector("#paint")!.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: 100000,
          fill: "both",
        });
        animation.currentTime = 25000;
      });
    }
    await captureRealWorldScrollReference(page, "body", { x: 0, y: 0, width: 320, height: 200 });
    for (const frame of page.frames()) {
      const before = await frame.evaluate(() => ({
        time: document.getAnimations()[0].currentTime,
        state: document.getAnimations()[0].playState,
      }));
      expect(before.state).toBe("paused");
      expect(Number(before.time)).toBeGreaterThanOrEqual(25000);
      expect(Number(before.time)).toBeLessThan(30000);
      await page.waitForTimeout(50);
      expect(await frame.evaluate(() => document.getAnimations()[0].currentTime)).toBe(before.time);
    }
  } finally {
    await page.close();
  }
}, 30000);

it("captures an unresolved inactive scroll animation without waiting for its ready promise", async () => {
  const page = await browser.newPage({ viewport: { width: 320, height: 200 } });
  try {
    await page.setContent(`<!doctype html><style>
      body{margin:0}#scroller{width:200px;height:100px;overflow:auto}
      #content{height:80px}#paint{width:50px;height:50px;background:lime;
        animation:detect-scroll 1s linear both;animation-timeline:scroll()}
      @keyframes detect-scroll{from{opacity:0}to{opacity:1}}
      </style><div id="scroller"><div id="content"><div id="paint"></div></div></div>`);
    await page.waitForFunction(() => document.getAnimations().length === 1);
    const before = await page.evaluate(() => {
      const animation = document.getAnimations()[0];
      return {
        currentTime: animation.currentTime,
        timelineTime: animation.timeline?.currentTime,
        progress: animation.effect?.getComputedTiming().progress,
      };
    });
    expect(before).toEqual({ currentTime: null, timelineTime: null, progress: null });
    await freezeRealWorldDom(page);
    const captured = await withTimeout(
      captureRealWorldScrollReference(page, "body", { x: 0, y: 0, width: 320, height: 200 }),
      5000,
      null,
    );
    expect(captured, "inactive animation blocked capture").not.toBeNull();
    expect(
      await page.evaluate(() => {
        const animation = document.getAnimations()[0];
        return {
          currentTime: animation.currentTime,
          timelineTime: animation.timeline?.currentTime,
          progress: animation.effect?.getComputedTiming().progress,
        };
      }),
    ).toEqual(before);
  } finally {
    await page.close();
  }
}, 10000);

it("retains an active scroll timeline's sampled percentage when it later becomes inactive", async () => {
  const page = await browser.newPage({ viewport: { width: 320, height: 200 } });
  try {
    await page.setContent(`<!doctype html><style>
      body{margin:0}#scroller{width:200px;height:100px;overflow:auto}
      #content{height:400px}#paint{width:50px;height:50px;background:lime;
        animation:detect-scroll 1s linear both;animation-timeline:scroll()}
      @keyframes detect-scroll{from{opacity:0}to{opacity:1}}
      </style><div id="scroller"><div id="content"><div id="paint"></div></div></div>`);
    await page.locator("#scroller").evaluate((element) => {
      element.scrollTop = 150;
    });
    await page.waitForFunction(() => document.getAnimations()[0]?.effect?.getComputedTiming().progress === 0.5);
    const sample = () =>
      page.evaluate(() => {
        const animation = document.getAnimations()[0];
        return {
          time: String(animation.currentTime),
          progress: animation.effect?.getComputedTiming().progress,
          opacity: getComputedStyle(document.querySelector("#paint")!).opacity,
        };
      });
    const active = await sample();
    await captureRealWorldScrollReference(page, "body", { x: 0, y: 0, width: 320, height: 200 });
    expect(await sample()).toEqual(active);
    expect(await page.evaluate(() => document.getAnimations()[0].playState)).toBe("paused");
    await page.locator("#content").evaluate((element) => {
      (element as HTMLElement).style.height = "80px";
    });
    await page.waitForFunction(() => document.getAnimations()[0].timeline?.currentTime == null);
    const inactive = await sample();
    await captureRealWorldScrollReference(page, "body", { x: 0, y: 0, width: 320, height: 200 });
    expect(await sample()).toEqual(inactive);
    expect(inactive).toEqual(active);
  } finally {
    await page.close();
  }
}, 10000);
