import type { Browser, Page } from "@playwright/test";
import sharp from "sharp";
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
  // An explicit inline `visibility:visible!important` outranks every author
  // stylesheet, so isolation hides this guard through a transition-priority
  // effect instead of its style attribute (DM-Q4J4JG): no callbacks.
  {
    name: "explicit visible",
    attribute: ' style="visibility:visible!important; COLOR : red ; --note:  one  ; "',
    callbacks: 0,
  },
  // A stylesheet `!important` also defeats a plain script animation.
  { name: "sheet-important visible", attribute: ' class="visible-important"', callbacks: 0 },
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
    `<style>html,body{margin:0;background:white}.visible-important{visibility:visible!important}x-containment-guard,span,button{display:block;contain:layout;width:40px;height:20px}button,select{margin:8px}</style><x-containment-guard${attribute}></x-containment-guard><span></span><span></span>${controls}`,
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

describe("native checkbox source styles during screenshot capture (DM-NGE3GT)", () => {
  it.each([
    { name: "absent", attribute: "", expected: null, focus: false },
    { name: "absent and focused", attribute: "", expected: null, focus: true },
    { name: "empty", attribute: ' style=""', expected: "", focus: false },
    {
      name: "authored",
      attribute: ' style=" COLOR : red ; --note:  one  ; "',
      expected: " COLOR : red ; --note:  one  ; ",
      focus: false,
    },
  ])("preserves $name styles under a live affine owner", async ({ attribute, expected, focus }) => {
    const viewport = { width: 320, height: 240 };
    const page = await browser.newPage({ viewport });
    try {
      await page.setContent(
        `<style>@keyframes sample{from,to{transform:scale(1.5,1.25)}}#owner{animation:sample 2s -1s linear both paused} span{display:inline-block}</style><div id="owner"><span>quick world<input type="checkbox" checked${attribute}></span></div>`,
      );
      const input = page.locator('input[type="checkbox"]');
      if (focus) await input.focus();
      expect(await input.getAttribute("style")).toBe(expected);
      const observed = await input.evaluateHandle((checkbox) => {
        const values: (string | null)[] = [];
        const observer = new MutationObserver((records) => {
          values.push(...records.map((record) => record.oldValue), checkbox.getAttribute("style"));
        });
        observer.observe(checkbox, { attributes: true, attributeFilter: ["style"], attributeOldValue: true });
        return values;
      });
      const paint = await page.screenshot({ caret: "initial" });
      const capture = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, ...viewport });
      expect(await input.getAttribute("style")).toBe(expected);
      expect(await input.evaluate((checkbox) => checkbox.matches(":focus"))).toBe(focus);
      const changes = await observed.jsonValue();
      expect(changes.some((value) => value?.includes("visibility: visible !important"))).toBe(true);
      expect(changes.some((value) => value?.includes("caret-color"))).toBe(false);
      expect(await page.screenshot({ caret: "initial" })).toEqual(paint);
      expect(capture.warnings.filter((warning) => warning.feature === "native-control-raster")).toEqual([]);
      const raster = walk(capture.tree).find((node) => node.tag === "input")?.nativeControlRaster;
      expect(raster?.dataUri).toMatch(/^data:image\/png;base64,/);
    } finally {
      await page.close();
    }
  });
});

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
        expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
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

    it.each([styles[2], styles[3]])(
      `restores $name attributes after failed ${profile.name} readback`,
      async ({ attribute }) => {
        const page = await browser.newPage({ viewport });
        try {
          await setup(page, attribute, profile.controls);
          const before = await state(page);
          const original = page.screenshot.bind(page);
          page.screenshot = async (options) => {
            if (options?.omitBackground === true) throw new Error("D8 forced isolation readback failure");
            return original(options);
          };
          const capture = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, ...viewport });
          expect(await state(page)).toEqual(before);
          expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
          expect(capture.warnings.some((warning) => warning.feature === profile.feature)).toBe(true);
        } finally {
          await page.close();
        }
      },
    );
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

// DM-Q4J4JG: isolation hid explicitly visible custom elements by writing their
// style attribute, which ran observed-`style` attributeChangedCallbacks twice.
// Custom elements now take an effect-owned visibility instead.
describe("custom-element visibility isolation without attribute writes (DM-Q4J4JG)", () => {
  type IsolationObservation = { visibility: string; style: string | null; animations: number; alpha: number };

  /** Record the guard's state and its painted alpha in the actual isolation readback. */
  async function observeIsolation(page: Page): Promise<IsolationObservation[]> {
    const seen: IsolationObservation[] = [];
    const original = page.screenshot.bind(page);
    page.screenshot = async (options) => {
      if (options?.omitBackground !== true) return original(options);
      const guard = await page.evaluate(() => {
        const node = document.querySelector("x-containment-guard")!;
        const rect = node.getBoundingClientRect();
        return {
          visibility: getComputedStyle(node).visibility,
          style: node.getAttribute("style"),
          animations: node.getAnimations().length,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        };
      });
      const frame = await original(options);
      const { data, info } = await sharp(frame).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      let alpha = 0;
      for (let y = Math.ceil(guard.rect.y); y < Math.floor(guard.rect.y + guard.rect.height); y++)
        for (let x = Math.ceil(guard.rect.x); x < Math.floor(guard.rect.x + guard.rect.width); x++)
          alpha = Math.max(alpha, data[(y * info.width + x) * info.channels + 3]);
      seen.push({ visibility: guard.visibility, style: guard.style, animations: guard.animations, alpha });
      return frame;
    };
    return seen;
  }

  for (const profile of profiles) {
    it(`hides a painted explicit-visible guard in the ${profile.name} isolation frame without callbacks`, async () => {
      const page = await browser.newPage({ viewport });
      try {
        await page.setContent(
          `<style>html,body{margin:0;background:white}x-containment-guard{background:red}x-containment-guard,span,button{display:block;contain:layout;width:40px;height:20px}button,select{margin:8px}</style><x-containment-guard${styles[3].attribute}></x-containment-guard><span></span>${profile.controls}`,
        );
        await observeGuard(page);
        const before = await state(page);
        const seen = await observeIsolation(page);
        const capture = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, ...viewport });
        // A full-control capture without a supplied source image first reads
        // one unmodified transparent source frame; the last readback is isolation.
        expect(seen.length).toBe(profile.name === "full" ? 2 : 1);
        // The tier-2 transition-priority effect hides it; the attribute is untouched.
        expect(seen.at(-1)).toEqual({ visibility: "hidden", style: before.style, animations: 1, alpha: 0 });
        expect(await state(page)).toEqual(before);
        expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
        expect(capture.warnings.filter((warning) => warning.feature === profile.feature)).toEqual([]);
      } finally {
        await page.close();
      }
    });
  }

  it("falls back to the inline write when an author visibility animation suppresses transition priority", async () => {
    // css_animations.cc CalculateTransitionActiveInterpolations erases
    // transition-priority values for any property a default-priority animation
    // on the element animates, so neither effect tier can take the value here.
    const page = await browser.newPage({ viewport });
    try {
      await page.setContent(
        `<style>html,body{margin:0;background:white}@keyframes keep{from,to{visibility:visible}}x-containment-guard{background:red;animation:keep 100s infinite}x-containment-guard,span,button{display:block;contain:layout;width:40px;height:20px}button{margin:8px}</style><x-containment-guard${styles[3].attribute}></x-containment-guard><span></span>${profiles[0].controls}`,
      );
      await observeGuard(page);
      const before = await state(page);
      const seen = await observeIsolation(page);
      const capture = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, ...viewport });
      const after = await state(page);
      const isolation = seen.at(-1)!;
      expect(seen).toHaveLength(2);
      expect(isolation.visibility).toBe("hidden");
      expect(isolation.alpha).toBe(0);
      expect(isolation.style).not.toBe(before.style);
      expect(after.style).toBe(before.style);
      // The fallback still costs the two callbacks the inline write always did.
      expect(after.styles - before.styles).toBe(2);
      expect(
        await page.evaluate(() => document.getAnimations().map((animation) => animation.constructor.name)),
      ).toEqual(["CSSAnimation"]);
      expect(capture.warnings.filter((warning) => warning.feature === "native-control-raster")).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it("re-shows a customized built-in target without its style callbacks", async () => {
    const page = await browser.newPage({ viewport });
    try {
      await page.setContent(
        '<style>html,body{margin:0;background:white}button{display:block;width:40px;height:20px;margin:8px}</style><button is="x-guarded-button"></button><button></button>',
      );
      await page.evaluate(() => {
        const state = { styles: 0 };
        customElements.define(
          "x-guarded-button",
          class extends HTMLButtonElement {
            static get observedAttributes() {
              return ["style"];
            }
            attributeChangedCallback() {
              state.styles++;
            }
          },
          { extends: "button" },
        );
        Object.defineProperty(window, "__q4State", { value: state });
      });
      const markup = () => page.evaluate(() => document.documentElement.outerHTML);
      const callbacks = () =>
        page.evaluate(() => (window as typeof window & { __q4State: { styles: number } }).__q4State.styles);
      const before = { markup: await markup(), callbacks: await callbacks() };
      const capture = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, ...viewport });
      expect(await markup()).toBe(before.markup);
      expect(await callbacks()).toBe(before.callbacks);
      const rasters = walk(capture.tree)
        .map((node) => node.nativeControlRaster)
        .filter((raster) => raster != null);
      expect(rasters).toHaveLength(2);
      // The customized built-in and the plain button paint the same native stamp.
      expect(rasters[0].dataUri).toBeDefined();
      expect(rasters[0].dataUri).toBe(rasters[1].dataUri);
      expect(capture.warnings.filter((warning) => warning.feature === "native-control-raster")).toEqual([]);
    } finally {
      await page.close();
    }
  });
});

// DM-AK8DWV: the capture script's color-normalization probe was appended to
// <body> and never removed, leaving one hidden <div> per capture.
describe("capture-local probes leave no source residue (DM-AK8DWV)", () => {
  it("removes the color probe after each capture, including an absent root", async () => {
    const page = await browser.newPage({ viewport });
    try {
      await page.setContent(
        `<style>html,body{margin:0}span{display:block;width:40px;height:20px;color:oklch(0.6 0.2 30)}</style><span></span>`,
      );
      const markup = () => page.evaluate(() => document.body.outerHTML);
      const before = await markup();
      await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, ...viewport });
      await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, ...viewport });
      await captureElementTreeWithWarnings(page, "#absent", { x: 0, y: 0, ...viewport });
      expect(await markup()).toBe(before);
    } finally {
      await page.close();
    }
  });
});
