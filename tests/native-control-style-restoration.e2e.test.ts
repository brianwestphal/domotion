import type { Browser, Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureElementTreeWithWarnings, launchChromium } from "../src/capture/index.js";
import { rasterizeNativeControlSurfaces } from "../src/capture/native-control-raster.js";
import type { CapturedElement, CaptureWarning } from "../src/capture/types.js";
import { capturedElement } from "../src/test-support/captured-fixtures.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(async () => closeBrowserSafely(browser));
const viewport = { width: 200, height: 160 };
const styles = [
  { name: "absent", attribute: "", callbacks: 0 },
  { name: "empty", attribute: ' style=""', callbacks: 0 },
  { name: "literal", attribute: ' style=" COLOR : red ; --note:  one  ; "', callbacks: 0 },
  // Restoring a literal does not undo callbacks from a required override.
  // DM-Q4J4JG owns removing this remaining author-runtime mutation.
  {
    name: "explicit visible",
    attribute: ' style="visibility:visible!important; COLOR : red ; --note:  one  ; "',
    callbacks: 2,
  },
] as const;
const profiles = [
  { name: "full", controls: "<button></button><button></button>", feature: "native-control-raster" },
  {
    name: "partial",
    controls: '<select style="background:#eee"><option>One</option></select>',
    feature: "native-control-decoration-raster",
  },
] as const;

async function setup(page: Page, attribute: string, controls: string): Promise<void> {
  await page.setContent(
    `<style>html,body{margin:0;background:white}x-containment-guard,span,button{display:block;contain:layout;width:40px;height:20px}button,select{margin:8px}</style><x-containment-guard${attribute}></x-containment-guard><span></span><span></span>${controls}`,
  );
  await observeGuard(page);
}

async function observeGuard(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = { constructed: 0, connected: 0, styles: 0 };
    customElements.define(
      "x-containment-guard",
      class extends HTMLElement {
        static get observedAttributes() {
          return ["style"];
        }
        constructor() {
          super();
          state.constructed++;
        }
        connectedCallback() {
          state.connected++;
        }
        attributeChangedCallback() {
          state.styles++;
        }
      },
    );
    Object.defineProperty(window, "__d8State", { value: state });
    Object.defineProperty(window, "__d8Authored", { value: Array.from(document.querySelectorAll("*")) });
  });
}

function state(page: Page) {
  return page.evaluate(() => ({
    // DM-AK8DWV tracks ColorNorm probe lifecycle. Check every
    // originally authored node without treating added measurement nodes as ours.
    authored: (window as typeof window & { __d8Authored: Element[] }).__d8Authored.map((node) => ({
      connected: node.isConnected,
      name: node.localName,
      attributes: Array.from(node.attributes, (attribute) => [attribute.name, attribute.value]),
    })),
    guardMarkup: document.querySelector("x-containment-guard")!.outerHTML,
    style: document.querySelector("x-containment-guard")!.getAttribute("style"),
    ...(window as typeof window & { __d8State: { constructed: number; connected: number; styles: number } }).__d8State,
  }));
}

const walk = (nodes: CapturedElement[]): CapturedElement[] => nodes.flatMap((node) => [node, ...walk(node.children)]);

describe("native control source style restoration (DM-D8Y3WJ)", () => {
  for (const profile of profiles) {
    it.each(styles)(`preserves $name attributes with ${profile.name} controls`, async ({ attribute, callbacks }) => {
      const page = await browser.newPage({ viewport });
      try {
        await setup(page, attribute, profile.controls);
        const before = await state(page);
        const paint = await page.screenshot();
        const capture = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, ...viewport });
        const after = await state(page);
        expect(after.authored).toEqual(before.authored);
        expect(after.guardMarkup).toBe(before.guardMarkup);
        expect(after.style).toBe(before.style);
        expect(after.constructed).toBe(1);
        expect(after.connected).toBe(1);
        expect(after.styles - before.styles).toBe(callbacks);
        expect(await page.screenshot()).toEqual(paint);
        expect(capture.warnings.filter((warning) => warning.feature === profile.feature)).toEqual([]);
        const rasters = walk(capture.tree)
          .map((node) => (profile.name === "full" ? node.nativeControlRaster : node.nativeControlDecorationRaster))
          .filter((raster) => raster != null);
        expect(rasters).toHaveLength(profile.name === "full" ? 2 : 1);
        expect(rasters.every((raster) => raster.dataUri?.startsWith("data:image/png;base64,") === true)).toBe(true);
      } finally {
        await page.close();
      }
    });

    it(`restores attributes after failed ${profile.name} readback`, async () => {
      const page = await browser.newPage({ viewport });
      try {
        await setup(page, styles[2].attribute, profile.controls);
        const before = await state(page);
        const original = page.screenshot.bind(page);
        page.screenshot = async (options) => {
          if (options?.omitBackground === true) throw new Error("D8 forced isolation readback failure");
          return original(options);
        };
        const capture = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, ...viewport });
        expect(await state(page)).toEqual(before);
        expect(capture.warnings.some((warning) => warning.feature === profile.feature)).toBe(true);
      } finally {
        await page.close();
      }
    });
  }

  it("keeps the original touching-button source fixture exact without claiming its overlapping stamps", async () => {
    const page = await browser.newPage({ viewport: { width: 200, height: 100 } });
    try {
      await page.setContent(
        "<style>x-containment-guard,span,button{display:block;contain:layout;width:40px;height:20px}</style><x-containment-guard></x-containment-guard><span></span><span></span><button></button><button></button>",
      );
      await observeGuard(page);
      const before = await state(page);
      const capture = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 200, height: 100 });
      const after = await state(page);
      expect(after.guardMarkup).toBe(before.guardMarkup);
      expect(after.style).toBe(before.style);
      expect(after.styles).toBe(before.styles);
      expect(after.constructed).toBe(before.constructed);
      expect(after.connected).toBe(before.connected);
      // DM-W4VADZ tracks the independent overflowing-body scrollbar baseline
      // boundary; the exact original custom guard remains required here.
      expect(
        capture.warnings.some(
          (warning) =>
            warning.feature === "native-control-raster" && warning.detail.includes("overlapping native owners"),
        ),
      ).toBe(true);
    } finally {
      await page.close();
    }
  });

  it("does not mutate any style or call the guard without native controls", async () => {
    const page = await browser.newPage({ viewport });
    try {
      await setup(page, styles[2].attribute, "");
      const before = await state(page);
      await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, ...viewport });
      expect(await state(page)).toEqual(before);
    } finally {
      await page.close();
    }
  });

  it("suppresses every native stamp when source attribute restoration fails", async () => {
    const page = await browser.newPage({ viewport });
    const key = "__d8Owners";
    try {
      await page.setContent(
        '<style>body{margin:0}</style><button style="position:absolute;left:20px;top:20px;width:40px;height:20px"></button>',
      );
      await page.evaluate((key) => {
        const button = document.querySelector("button")!;
        (globalThis as typeof globalThis & Record<string, unknown>)[key] = [button];
        // Force a real restore failure after successful isolation writes.
        const original = button.getAttribute("style");
        const set = button.setAttribute.bind(button);
        button.setAttribute = (name, value) => {
          if (name === "style" && value === original) throw new Error("D8 blocked restoration");
          set(name, value);
        };
      }, key);
      const image = capturedElement({
        tag: "button",
        x: 20,
        y: 20,
        width: 40,
        height: 20,
        styles: {},
        children: [],
        nativeControlRaster: { x: 20, y: 20, width: 40, height: 20, sourceNodeIndex: 0, selector: "button" },
      });
      const warnings: CaptureWarning[] = [];
      await rasterizeNativeControlSurfaces(
        page,
        [image],
        { x: 0, y: 0, ...viewport },
        { sourceNodeKey: key, warnings },
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0].detail).toContain("source style attribute restore failed");
      expect(image.nativeControlRaster?.dataUri).toBeUndefined();
      expect(image.nativeControlRaster?.empty).toBeUndefined();
      expect(image.nativeControlRaster?.sourceNodeIndex).toBeUndefined();
    } finally {
      await page.close();
    }
  });
});
