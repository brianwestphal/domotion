import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { chromium, type Browser } from "@playwright/test";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";

import type { CapturedElement } from "../src/capture/types.js";
import { captureElementTree, elementTreeToSvgInner } from "../src/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

const FIXTURE_URL = pathToFileURL(resolve("tests/fixtures/html-test/36-composed-metamorphic-parity.html")).href;

const env = await (async () => {
  try {
    return { browser: await chromium.launch() };
  } catch {
    return null;
  }
})();

afterAll(async () => closeBrowserSafely(env?.browser as Browser | null | undefined), 15_000);
const describeBrowser = env == null ? describe.skip : describe;

function walk(nodes: CapturedElement[]): CapturedElement[] {
  return nodes.flatMap((node) => [node, ...walk(node.children ?? [])]);
}

function digest(uri: string): string {
  return createHash("sha256").update(Buffer.from(uri.slice(uri.indexOf(",") + 1), "base64")).digest("hex");
}

async function averageRgb(uri: string): Promise<{ r: number; g: number; b: number }> {
  const bytes = Buffer.from(uri.slice(uri.indexOf(",") + 1), "base64");
  const { data } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 16) continue;
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
    count++;
  }
  return { r: r / count, g: g / count, b: b / count };
}

describeBrowser("composed parity corpus live relations", () => {
  it("activates all six metamorphic relations in live Chromium", async () => {
    const context = await env!.browser.newContext({ viewport: { width: 1024, height: 768 } });
    const page = await context.newPage();
    try {
      await page.goto(FIXTURE_URL);
      await page.evaluate(() => document.fonts.ready);
      const facts = await page.evaluate(() => {
        type Rect = { x: number; y: number; width: number; height: number };
        const specimen = (family: string, variant: string): HTMLElement =>
          document.querySelector(`[data-family="${family}"] [data-variant="${variant}"]`)!;
        const relativeRect = (family: string, variant: string, probe: string): Rect => {
          const stage = specimen(family, variant);
          const target = stage.querySelector(`[data-probe="${probe}"]`)!;
          const stageRect = stage.getBoundingClientRect();
          const rect = target.getBoundingClientRect();
          return { x: rect.x - stageRect.x, y: rect.y - stageRect.y, width: rect.width, height: rect.height };
        };
        const controlStyle = (variant: string) => {
          const target = specimen("responsive-fragmented-controls", variant).querySelector("[data-probe=control-layout]")!;
          const style = getComputedStyle(target);
          const rect = target.getBoundingClientRect();
          return {
            display: style.display,
            columns: style.gridTemplateColumns,
            columnGap: style.columnGap,
            rowGap: style.rowGap,
            width: rect.width,
            height: rect.height,
          };
        };
        const order = (variant: string) => Array.from(
          specimen("gradient-mask-clip-stacking", variant).querySelectorAll<HTMLElement>("[data-layer]"),
          (element) => ({ layer: element.dataset.layer!, zIndex: getComputedStyle(element).zIndex }),
        );
        const splitTarget = specimen("multilingual-flex-grid", "node-split").querySelector("[data-probe=message]")!;
        return {
          multilingual: {
            base: relativeRect("multilingual-flex-grid", "base", "message"),
            neutral: relativeRect("multilingual-flex-grid", "neutral-wrapper", "message"),
            split: relativeRect("multilingual-flex-grid", "node-split", "message"),
            splitChildren: splitTarget.children.length,
          },
          controls: { base: controlStyle("base"), equivalent: controlStyle("equivalent-syntax") },
          translation: {
            base: relativeRect("svg-effects", "base", "svg-effect"),
            variant: relativeRect("svg-effects", "translation", "svg-effect"),
          },
          scale: {
            base: relativeRect("zoom-transforms", "base", "scale-target"),
            variant: relativeRect("zoom-transforms", "scale", "scale-target"),
          },
          iframe: {
            base: relativeRect("same-origin-iframe", "base", "frame"),
            neutral: relativeRect("same-origin-iframe", "neutral-wrapper", "frame"),
          },
          order: { base: order("base"), variant: order("dom-order") },
        };
      });

      expect(facts.multilingual.neutral).toEqual(facts.multilingual.base);
      expect(facts.multilingual.split).toEqual(facts.multilingual.base);
      expect(facts.multilingual.splitChildren).toBeGreaterThan(3);
      expect(facts.controls.equivalent).toEqual(facts.controls.base);
      expect(facts.iframe.neutral).toEqual(facts.iframe.base);
      expect(facts.order.base.map((row) => row.layer)).toEqual(["back", "front"]);
      expect(facts.order.variant.map((row) => row.layer)).toEqual(["front", "back"]);
      expect(Object.fromEntries(facts.order.variant.map((row) => [row.layer, row.zIndex]))).toEqual(
        Object.fromEntries(facts.order.base.map((row) => [row.layer, row.zIndex])),
      );
      expect(facts.translation.variant.x - facts.translation.base.x).toBeCloseTo(12, 2);
      expect(facts.translation.variant.y - facts.translation.base.y).toBeCloseTo(8, 2);
      expect(facts.translation.variant.width).toBeCloseTo(facts.translation.base.width, 2);
      expect(facts.translation.variant.height).toBeCloseTo(facts.translation.base.height, 2);
      expect(facts.scale.variant.width / facts.scale.base.width).toBeCloseTo(1.25, 2);
      expect(facts.scale.variant.height / facts.scale.base.height).toBeCloseTo(1.25, 2);
    } finally {
      await context.close();
    }
  }, 60_000);

  it("recurses the same-origin frame while freezing the current canvas pixels", async () => {
    const context = await env!.browser.newContext({ viewport: { width: 1024, height: 768 } });
    const page = await context.newPage();
    try {
      await page.goto(FIXTURE_URL);
      await page.evaluate(() => document.fonts.ready);
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 1024, height: 768 });
      const nodes = walk(tree);
      const frame = nodes.find((node) => node.tag === "iframe");
      expect(frame?.replacedSnapshot, "same-origin iframe should remain native SVG").toBeUndefined();
      expect(frame?.children.length, "same-origin iframe should recurse into its document").toBeGreaterThan(0);
      expect(walk(frame!.children).some((node) => node.text.includes("inner frame"))).toBe(true);

      const snapshot = nodes.find((node) => node.tag === "canvas")?.replacedSnapshot?.dataUri;
      expect(snapshot).toMatch(/^data:image\/png;base64,/);
      const capturedColor = await averageRgb(snapshot!);
      expect(capturedColor.r).toBeGreaterThan(capturedColor.g + 35);

      const liveBefore = await page.locator("canvas[data-probe=dynamic-canvas]").first().evaluate((canvas) =>
        (canvas as HTMLCanvasElement).toDataURL("image/png"),
      );
      await page.evaluate(() => (window as typeof window & { advanceComposedCanvas(): void }).advanceComposedCanvas());
      const liveAfter = await page.locator("canvas[data-probe=dynamic-canvas]").first().evaluate((canvas) =>
        (canvas as HTMLCanvasElement).toDataURL("image/png"),
      );
      expect(digest(liveAfter)).not.toBe(digest(liveBefore));
      expect(digest(snapshot!)).not.toBe(digest(liveAfter));
      const mutatedColor = await averageRgb(liveAfter);
      expect(mutatedColor.g + mutatedColor.b).toBeGreaterThan(mutatedColor.r * 2);

      const svg = elementTreeToSvgInner(tree, 1024, 768);
      expect(svg).toContain(snapshot!);
      expect(svg).toContain("inner frame");
      expect(svg).not.toContain(liveAfter);
    } finally {
      await context.close();
    }
  }, 60_000);
});
