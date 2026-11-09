import { chromium, type Browser } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { imageRootFontMetricUnits } from "../src/render/svg-image-root-font.js";

const cases = [
  { family: "Arial", size: 13, weight: 400 },
  { family: "Arial", size: 19.5, weight: 400 },
  { family: "Arial", size: 24, weight: 700 },
  { family: "Times New Roman", size: 16, weight: 400 },
  { family: "Helvetica", size: 16, weight: 400 },
  { family: "Helvetica", size: 24, weight: 400 },
  { family: "Courier", size: 16, weight: 400 },
  { family: "Georgia", size: 24, weight: 400 },
  { family: "serif", size: 16, weight: 400 },
  { family: "sans-serif", size: 16, weight: 400 },
  { family: "monospace", size: 16, weight: 400 },
  { family: "system-ui", size: 16, weight: 400 },
] as const;

describe.skipIf(process.platform !== "darwin")("image SVG root normal lh on macOS", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  it("matches Chromium's computed 100lh across selected faces, weights, and sizes", async () => {
    const page = await browser.newPage();
    try {
      for (const sample of cases) {
        const chrome = await page.evaluate(({ family, size, weight }) => {
          const div = document.createElement("div");
          div.style.cssText = `font-family:${family};font-size:${size}px;font-weight:${weight};line-height:normal;width:100lh;position:absolute`;
          document.body.append(div);
          const width = parseFloat(getComputedStyle(div).width) / 100;
          div.remove();
          return width;
        }, sample);
        const declarations = {
          get: (property: string): string | null =>
            property === "font-family" ? sample.family : property === "font-weight" ? String(sample.weight) : null,
        };
        const rendered = imageRootFontMetricUnits(declarations, sample.size, null)?.("lh");
        expect(rendered, JSON.stringify(sample)).not.toBeNull();
        expect(Math.abs((rendered ?? 0) - chrome), JSON.stringify(sample)).toBeLessThan(0.01);
      }
    } finally {
      await page.close();
    }
  });
});
