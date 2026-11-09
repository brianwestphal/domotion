import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "@playwright/test";
import { launchChromium } from "../src/capture/index.js";
import { rasterizeReplacedElements } from "../src/capture/replaced-element-raster.js";
import { capturedElement } from "../src/test-support/captured-fixtures.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(async () => {
  await closeBrowserSafely(browser);
});

async function fixture(pseudo = false): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 100, height: 100 } });
  await page.setContent(`<style>
    body { margin:0; background:rgb(12,20,40) }
    #backdrop { position:absolute; inset:0; ${pseudo ? "" : "background:rgba(255,255,255,.2);transition:all 30s linear"} }
    ${pseudo ? '#backdrop::before{content:"";position:absolute;inset:0;background:rgba(255,255,255,.2);transition:all 30s linear}' : ""}
    canvas { position:absolute; inset:0; display:block }
  </style><div id="backdrop"></div><canvas data-domotion-rid="dr0" width="100" height="100"></canvas>`);
  await page.locator("canvas").evaluate((canvas: HTMLCanvasElement) => {
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    context.fillStyle = "rgb(0,80,240)";
    context.fillRect(30, 30, 40, 40);
  });
  return page;
}

function target() {
  return capturedElement({
    tag: "canvas",
    children: [],
    styles: { transform: "none" },
    replacedSnapshot: { rid: "dr0", x: 0, y: 0, width: 100, height: 100 },
  });
}

async function pixel(uri: string, x: number, y: number): Promise<number[]> {
  return [
    ...(await sharp(Buffer.from(uri.split(",")[1], "base64"))
      .ensureAlpha()
      .extract({ left: x, top: y, width: 1, height: 1 })
      .raw()
      .toBuffer()),
  ];
}

describe("replaced snapshot visibility transitions", () => {
  for (const pseudo of [false, true]) {
    it(`excludes a transition-all ${pseudo ? "pseudo" : "image-like backdrop"} without doubling alpha`, async () => {
      const page = await fixture(pseudo);
      try {
        const source = await page.screenshot();
        const element = target();
        const report = await rasterizeReplacedElements(page, [element], { x: 0, y: 0, width: 100, height: 100 });
        expect(report.failures).toEqual([]);
        const uri = element.replacedSnapshot!.dataUri!;
        expect(await pixel(uri, 10, 10)).toEqual([0, 0, 0, 0]);
        expect(await pixel(uri, 50, 50)).toEqual([0, 80, 240, 255]);
        expect((await page.screenshot()).equals(source)).toBe(true);
        expect(await page.locator("[data-domotion-snapshot-target], [data-domotion-rid]").count()).toBe(0);
      } finally {
        await page.close();
      }
    });
  }

  it("preserves an existing paused opacity transition and authored inline priorities", async () => {
    const page = await fixture();
    try {
      const retained = await page.locator("#backdrop").evaluateHandle((node) => {
        node.style.setProperty("transition", "all 30s linear", "important");
        node.style.opacity = "0.2";
        void node.getBoundingClientRect();
        node.style.opacity = "0.8";
        const animation = node
          .getAnimations()
          .find((a) => a instanceof CSSTransition && a.transitionProperty === "opacity")!;
        animation.pause();
        animation.currentTime = 10_000;
        return {
          animation,
          currentTime: animation.currentTime,
          style: [node.style.transition, node.style.getPropertyPriority("transition"), node.style.opacity],
          attribute: node.getAttribute("style"),
        };
      });
      const before = await page.screenshot();
      const element = target();
      const report = await rasterizeReplacedElements(page, [element], { x: 0, y: 0, width: 100, height: 100 });
      expect(report.failures).toEqual([]);
      expect(
        await retained.evaluate(({ animation, currentTime, style, attribute }) => ({
          same: document.querySelector("#backdrop")!.getAnimations().includes(animation),
          time: animation.currentTime === currentTime,
          paused: animation.playState === "paused",
          attribute: document.querySelector("#backdrop")!.getAttribute("style") === attribute,
          style:
            JSON.stringify([
              (document.querySelector("#backdrop") as HTMLElement).style.transition,
              (document.querySelector("#backdrop") as HTMLElement).style.getPropertyPriority("transition"),
              (document.querySelector("#backdrop") as HTMLElement).style.opacity,
            ]) === JSON.stringify(style),
        })),
      ).toEqual({ same: true, time: true, paused: true, style: true, attribute: true });
      expect((await page.screenshot()).equals(before)).toBe(true);
      await retained.dispose();
    } finally {
      await page.close();
    }
  });

  it("rejects pre-existing authored visibility transitions without changing their state", async () => {
    const page = await fixture();
    try {
      const retained = await page.locator("#backdrop").evaluateHandle((node) => {
        node.style.visibility = "visible";
        void node.getBoundingClientRect();
        node.style.visibility = "hidden";
        const animation = node
          .getAnimations()
          .find((a) => a instanceof CSSTransition && a.transitionProperty === "visibility")!;
        animation.pause();
        animation.currentTime = 10_000;
        return { animation, currentTime: animation.currentTime, style: node.style.cssText };
      });
      const element = target();
      const report = await rasterizeReplacedElements(page, [element], { x: 0, y: 0, width: 100, height: 100 });
      expect(report.failures[0]?.detail).toContain("authored visibility transition is active");
      expect(element.replacedSnapshot!.dataUri).toBeUndefined();
      expect(
        await retained.evaluate(
          ({ animation, currentTime, style }) =>
            document.querySelector("#backdrop")!.getAnimations().includes(animation) &&
            animation.currentTime === currentTime &&
            animation.playState === "paused" &&
            (document.querySelector("#backdrop") as HTMLElement).style.cssText === style,
        ),
      ).toBe(true);
      await retained.dispose();
    } finally {
      await page.close();
    }
  });

  it("restores transition declarations and temporary selectors after screenshot failure", async () => {
    const page = await fixture(true);
    try {
      const before = await page.locator("#backdrop").getAttribute("style");
      const original = page.screenshot.bind(page);
      page.screenshot = async () => {
        throw new Error("deliberate screenshot failure");
      };
      const report = await rasterizeReplacedElements(page, [target()], { x: 0, y: 0, width: 100, height: 100 });
      page.screenshot = original;
      expect(report.failures[0]?.phase).toBe("screenshot");
      expect(await page.locator("#backdrop").getAttribute("style")).toBe(before);
      expect(
        await page.evaluate(() =>
          Array.from(document.querySelectorAll("*")).some((node) =>
            node.getAttributeNames().some((name) => name.startsWith("data-__domotionsnapshottransition_")),
          ),
        ),
      ).toBe(false);
    } finally {
      await page.close();
    }
  });
});
