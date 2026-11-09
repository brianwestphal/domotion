import { chromium } from "@playwright/test";
import { expect, it } from "vitest";
import { imageRootFontMetricUnits } from "../src/render/svg-image-root-font.js";

it.skipIf(process.platform !== "linux")("matches Linux Chromium normal lh across primary faces and sizes", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    for (const family of [
      "Arial",
      "Times New Roman",
      "Liberation Sans",
      "Liberation Serif",
      "serif",
      "sans-serif",
      "monospace",
      "system-ui",
    ]) {
      for (const size of [8, 13, 16, 19.5, 24, 32]) {
        const chrome = await page.evaluate(
          ({ family, size }) => {
            const div = document.createElement("div");
            div.style.cssText = `font-family:${family};font-size:${size}px;line-height:normal;width:100lh;position:absolute`;
            document.body.append(div);
            const width = parseFloat(getComputedStyle(div).width) / 100;
            div.remove();
            return width;
          },
          { family, size },
        );
        const declarations = { get: (property: string): string | null => (property === "font-family" ? family : null) };
        const rendered = imageRootFontMetricUnits(declarations, size, null)?.("lh");
        expect(rendered, `${family} ${size}px`).not.toBeNull();
        expect(Math.abs((rendered ?? 0) - chrome), `${family} ${size}px`).toBeLessThan(0.01);
      }
    }
  } finally {
    await page.close();
    await browser.close();
  }
});
