import type { Browser } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureElementTree, launchChromium } from "./index.js";
import { primeDecodedImageRatios } from "./decoded-image-ratio.js";
import { closeBrowserSafely } from "../test-support/close-browser-safely.js";

let png: string;
let browser: Browser;
beforeAll(async () => {
  const bytes = await sharp({ create: { width: 1, height: 1, channels: 3, background: "red" } })
    .png()
    .toBuffer();
  png = `data:image/png;base64,${bytes.toString("base64")}`;
  browser = await launchChromium();
});
afterAll(async () => {
  await closeBrowserSafely(browser);
}, 15_000);

describe("selected decoded image ratio ownership", () => {
  it("uses a Node deadline with page timers frozen and closes a late bitmap", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<img src="${png}" style="object-fit:cover">`);
      await page.locator("img").evaluate((image: HTMLImageElement) => image.decode());
      await page.evaluate(() => {
        const state = {
          closed: 0,
          resolve: undefined as ((bitmap: { width: number; height: number; close(): void }) => void) | undefined,
        };
        Object.defineProperty(window, "__ratioTest", { configurable: true, value: state });
        Object.defineProperty(window, "createImageBitmap", {
          configurable: true,
          value: () =>
            new Promise((resolve) => {
              state.resolve = resolve;
            }),
        });
        Object.defineProperty(window, "setTimeout", { configurable: true, value: () => 0 });
      });
      const prime = await primeDecodedImageRatios(page, 100);
      expect(prime.warnings).toHaveLength(1);
      expect(prime.warnings[0].detail).toContain("Node deadline");
      await prime.dispose();
      const after = await page.evaluate(async () => {
        const host = window as Window & {
          __ratioTest?: {
            closed: number;
            resolve?: (bitmap: { width: number; height: number; close(): void }) => void;
          };
          __domotionDecodedImageRatios?: unknown;
        };
        const state = host.__ratioTest;
        if (state == null) throw new Error("test state missing");
        state.resolve?.({
          width: 396,
          height: 581,
          close() {
            state.closed++;
          },
        });
        await Promise.resolve();
        await Promise.resolve();
        return { closed: state.closed, retainedRegistry: host.__domotionDecodedImageRatios != null };
      });
      expect(after).toEqual({ closed: 1, retainedRegistry: false });
    } finally {
      await page.close();
    }
  });

  it("reports unsupported orientation and leaves broken/loading owners alone", async () => {
    const page = await browser.newPage();
    try {
      await page.route("http://pending.test/image.png", () => undefined);
      await page.setContent(
        `<img src="${png}" style="object-fit:cover;image-orientation:none"><img src="data:image/png;base64,broken" style="object-fit:cover"><img src="http://pending.test/image.png" style="object-fit:cover">`,
        { waitUntil: "domcontentloaded" },
      );
      await page
        .locator("img")
        .first()
        .evaluate((image: HTMLImageElement) => image.decode());
      const prime = await primeDecodedImageRatios(page);
      try {
        expect(prime.warnings).toHaveLength(1);
        expect(prime.warnings[0].detail).toContain("image-orientation");
      } finally {
        await prime.dispose();
      }
      expect(await page.evaluate(() => Object.hasOwn(window, "__domotionDecodedImageRatios"))).toBe(false);
    } finally {
      await page.close();
    }
  });
  it("rejects foreign probe ownership without deleting its registry", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<img src="${png}" style="object-fit:cover">`);
      const owner = await primeDecodedImageRatios(page);
      try {
        await expect(primeDecodedImageRatios(page)).rejects.toThrow("already owned");
        expect(await page.evaluate(() => Object.hasOwn(window, "__domotionDecodedImageRatios"))).toBe(true);
      } finally {
        await owner.dispose();
      }
    } finally {
      await page.close();
    }
  });

  it("reads tainted selected resources, shadow roots and child frames without refetching", async () => {
    const page = await browser.newPage();
    let imageRequests = 0;
    try {
      await page.route("http://source.test/", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<img src="http://image.test/pixel.png" style="object-fit:cover"><div id="shadow"></div><iframe></iframe>`,
        }),
      );
      await page.route("http://image.test/pixel.png", (route) => {
        imageRequests++;
        return route.fulfill({ contentType: "image/png", body: Buffer.from(png.split(",")[1], "base64") });
      });
      await page.goto("http://source.test/");
      await page.evaluate((source) => {
        document.querySelector("#shadow")!.attachShadow({ mode: "open" }).innerHTML =
          `<img src="${source}" style="object-fit:cover">`;
        document.querySelector("iframe")!.srcdoc = `<img src="${source}" style="object-fit:contain">`;
      }, png);
      await page.waitForFunction(
        () => document.querySelector("iframe")?.contentDocument?.querySelector("img")?.complete,
      );
      const prime = await primeDecodedImageRatios(page);
      try {
        expect(prime.warnings).toEqual([]);
        for (const frame of page.frames()) {
          const facts = await frame.evaluate(() => {
            const state = (
              window as Window & {
                __domotionDecodedImageRatios?: {
                  facts: WeakMap<Element, { width: number; height: number }>;
                };
              }
            ).__domotionDecodedImageRatios;
            const image = document.querySelector("img");
            const shadowImage = document.querySelector("#shadow")?.shadowRoot?.querySelector("img");
            return [image, shadowImage]
              .filter((node): node is HTMLImageElement => node != null)
              .map((node) => {
                const fact = state?.facts.get(node);
                return fact == null ? null : [fact.width, fact.height];
              });
          });
          expect(facts.length).toBeGreaterThan(0);
          expect(facts.every((fact) => JSON.stringify(fact) === "[1,1]")).toBe(true);
        }
        expect(imageRequests).toBe(1);
      } finally {
        await prime.dispose();
      }
    } finally {
      await page.close();
    }
  });
  it("disposes published facts when the capture walk fails", async () => {
    const page = await browser.newPage({ viewport: { width: 100, height: 100 } });
    try {
      await page.setContent(`<img src="${png}" style="object-fit:cover">`);
      await page.locator("img").evaluate((image: HTMLImageElement) => image.decode());
      await page.evaluate(() => {
        const original = createImageBitmap.bind(window);
        let calls = 0;
        Object.defineProperty(window, "__ratioProbeCalls", { configurable: true, get: () => calls });
        Object.defineProperty(window, "createImageBitmap", {
          configurable: true,
          value: (image: HTMLImageElement) => {
            calls++;
            return original(image);
          },
        });
      });
      await expect(captureElementTree(page, "[", { x: 0, y: 0, width: 100, height: 100 })).rejects.toThrow();
      const state = await page.evaluate(() => ({
        calls: (window as Window & { __ratioProbeCalls?: number }).__ratioProbeCalls,
        retained: Object.hasOwn(window, "__domotionDecodedImageRatios"),
      }));
      expect(state.calls).toBeGreaterThan(0);
      expect(state.retained).toBe(false);
    } finally {
      await page.close();
    }
  });
});
