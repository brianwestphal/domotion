import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "@playwright/test";
import sharp from "sharp";
import { captureElementTreeWithWarnings, launchChromium } from "../src/capture/index.js";
import type { CapturedElement } from "../src/capture/types.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

const displays = [
  "block",
  "inline-block",
  "flow-root",
  "flex",
  "grid",
  "inline-flex",
  "inline-grid",
  "inline",
  "table",
  "inline-table",
  "table-row",
  "table-row-group",
  "table-cell",
  "ruby",
  "contents",
];
const ineligible = new Set(["inline", "ruby", "contents", "table-row", "table-row-group"]);
let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(async () => {
  await closeBrowserSafely(browser);
});
const walk = (nodes: CapturedElement[]): CapturedElement[] => nodes.flatMap((node) => [node, ...walk(node.children)]);
const pixel = async (png: Buffer): Promise<number[]> => [
  ...(await sharp(png).removeAlpha().extract({ left: 10, top: 10, width: 1, height: 1 }).raw().toBuffer()),
];

describe("native containment stacking eligibility (DM-5YF0BB)", () => {
  for (const position of ["absolute", "fixed"]) {
    it(`keeps eligible contexts atomic and excludes native non-box/table parts for ${position} children`, async () => {
      const page = await browser.newPage({ viewport: { width: 100, height: 80 } });
      const output = await browser.newPage({ viewport: { width: 100, height: 80 } });
      const selected = position === "absolute" ? displays : ["block", "inline", "table-row", "table-cell", "contents"];
      try {
        for (const display of selected) {
          await page.setContent(
            `<!doctype html><style>body{margin:0;background:white}.stage{position:relative;isolation:isolate;width:100px;height:80px}.host{position:relative;display:${display};contain:layout;width:60px;height:40px}.inner{position:${position};left:0;top:0;width:40px;height:40px;background:rgb(0,128,0);z-index:2}.outside{position:absolute;left:0;top:0;width:40px;height:40px;background:rgb(0,0,255);z-index:1}</style><div class="stage"><span class="host"><i class="inner"></i></span><i class="outside"></i></div>`,
          );
          const expected = ineligible.has(display) ? [0, 128, 0] : [0, 0, 255];
          expect(await pixel(await page.screenshot()), `native ${display}`).toEqual(expected);
          const captured = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 100, height: 80 });
          expect(captured.warnings).toEqual(
            position === "fixed"
              ? [
                  expect.objectContaining({
                    feature: "position:fixed",
                    detail: "rendered as a static snapshot at t=0; scroll-following behavior is not animated",
                  }),
                ]
              : [],
          );
          const hosts = walk(captured.tree).filter((node) => node.styles.contain === "layout");
          if (!ineligible.has(display)) expect(hosts).toHaveLength(1);
          for (const host of hosts)
            expect(host.styles.paintOrLayoutContainmentEligible, display).toBe(!ineligible.has(display));
          await output.setContent(`<style>body{margin:0}</style>${elementTreeToSvg(captured.tree, 100, 80)}`);
          expect(await pixel(await output.screenshot()), `rendered ${display}`).toEqual(expected);
        }
      } finally {
        await output.close();
        await page.close();
      }
    }, 90_000);
  }

  it("applies the shared native eligibility gate to paint/strict/content aliases", async () => {
    const page = await browser.newPage({ viewport: { width: 100, height: 80 } });
    const output = await browser.newPage({ viewport: { width: 100, height: 80 } });
    try {
      for (const contain of ["paint", "strict", "content"])
        for (const display of ["block", "inline", "table-row"]) {
          await page.setContent(
            `<!doctype html><style>body{margin:0;background:white}.stage{position:relative;isolation:isolate;width:100px;height:80px}.host{position:relative;display:${display};contain:${contain};width:60px;height:40px}.inner{position:absolute;left:0;top:0;width:40px;height:40px;background:green;z-index:2}.outside{position:absolute;left:0;top:0;width:40px;height:40px;background:blue;z-index:1}</style><div class="stage"><span class="host"><i class="inner"></i></span><i class="outside"></i></div>`,
          );
          const expected = display === "block" ? [0, 0, 255] : [0, 128, 0];
          expect(await pixel(await page.screenshot()), `${display}/${contain}`).toEqual(expected);
          const capture = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 100, height: 80 });
          await output.setContent(`<style>body{margin:0}</style>${elementTreeToSvg(capture.tree, 100, 80)}`);
          expect(await pixel(await output.screenshot()), `${display}/${contain}`).toEqual(expected);
        }
    } finally {
      await output.close();
      await page.close();
    }
  }, 90_000);

  it("caches neutral built-ins without modifying or constructing source custom elements", async () => {
    const page = await browser.newPage({ viewport: { width: 200, height: 100 } });
    try {
      await page.setContent(
        "<style>x-containment-guard,span{display:block;contain:layout;width:40px;height:20px}</style><x-containment-guard></x-containment-guard><span></span><span></span>",
      );
      await page.evaluate(() => {
        const state = { constructed: 0, connected: 0, probes: 0, probeSourceMutations: 0, probeCallbacks: 0 };
        let probing = false;
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
              if (probing) state.probeCallbacks++;
            }
          },
        );
        const source = document.querySelector("x-containment-guard")!;
        const observer = new MutationObserver(() => {});
        observer.observe(source, { attributes: true, childList: true, subtree: true });
        const isProbe = (node: Node): boolean =>
          node instanceof HTMLElement && node.getAttribute("aria-hidden") === "true" && node.style.contain === "layout";
        const append = Node.prototype.appendChild;
        Node.prototype.appendChild = function <T extends Node>(node: T): T {
          if (isProbe(node)) {
            observer.takeRecords();
            probing = true;
            state.probes++;
          }
          return append.call(this, node) as T;
        };
        const remove = Element.prototype.remove;
        Element.prototype.remove = function (): void {
          if (isProbe(this)) {
            state.probeSourceMutations += observer.takeRecords().length;
            probing = false;
          }
          remove.call(this);
        };
        Object.defineProperty(window, "__containmentTest", { value: state, configurable: true });
      });
      const before = await page.locator("x-containment-guard").evaluate((node) => node.outerHTML);
      const captured = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 200, height: 100 });
      expect(await page.locator("x-containment-guard").evaluate((node) => node.outerHTML)).toBe(before);
      // DM-D8Y3WJ tracks full native-control style-attribute restoration.
      // This contract measures our neutral probe interval without hiding it.
      // Capture runs text-geometry discovery and the final walk separately;
      // three matching owners need one cached probe in each invocation.
      expect(
        await page.evaluate(() => (window as typeof window & { __containmentTest: unknown }).__containmentTest),
      ).toEqual({ constructed: 1, connected: 1, probes: 2, probeSourceMutations: 0, probeCallbacks: 0 });
      const hosts = walk(captured.tree).filter((node) => ["x-containment-guard", "span", "button"].includes(node.tag));
      expect(hosts).toHaveLength(3);
      expect(hosts.every((node) => node.styles.paintOrLayoutContainmentEligible === true)).toBe(true);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("measures safe built-in button hosts instead of inferring eligibility from a source tag", async () => {
    const page = await browser.newPage({ viewport: { width: 100, height: 80 } });
    const output = await browser.newPage({ viewport: { width: 100, height: 80 } });
    try {
      for (const display of ["inline", "block", "inline-block"]) {
        await page.setContent(
          `<!doctype html><style>body{margin:0;background:white}.stage{position:relative;isolation:isolate;width:100px;height:80px}.host{position:relative;display:${display};contain:layout;width:60px;height:40px}.inner{position:absolute;left:0;top:0;width:40px;height:40px;background:green;z-index:2}.outside{position:absolute;left:0;top:0;width:40px;height:40px;background:blue;z-index:1}</style><div class="stage"><button class="host"><i class="inner"></i></button><i class="outside"></i></div>`,
        );
        expect(await pixel(await page.screenshot())).toEqual([0, 0, 255]);
        const capture = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 100, height: 80 });
        expect(walk(capture.tree).find((node) => node.tag === "button")?.styles.paintOrLayoutContainmentEligible).toBe(
          true,
        );
        await output.setContent(`<style>body{margin:0}</style>${elementTreeToSvg(capture.tree, 100, 80)}`);
        expect(await pixel(await output.screenshot())).toEqual([0, 0, 255]);
      }
    } finally {
      await output.close();
      await page.close();
    }
  }, 60_000);
});
