import { chromium } from "@playwright/test";
import { expect, it } from "vitest";
import { imageRootFontMetricUnits } from "../src/render/svg-image-root-font.js";

it.skipIf(process.platform !== "win32")("matches Windows Chromium SVG root ex/ch/cap/ic units", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    for (const sample of [
      { family: "", size: 20, weight: 400 },
      { family: "Georgia, serif", size: 16, weight: 700 },
      { family: "Menlo, monospace", size: 12, weight: 400 },
    ]) {
      const chrome = await page.evaluate(({ family, size, weight }) => {
        const result: Record<string, number> = {};
        for (const unit of ["ex", "ch", "cap", "ic"]) {
          const div = document.createElement("div");
          div.style.cssText = `font-family:${family};font-size:${size}px;font-weight:${weight};width:100${unit};position:absolute`;
          document.body.append(div);
          result[unit] = parseFloat(getComputedStyle(div).width) / 100;
          div.remove();
        }
        return result;
      }, sample);
      const declarations = {
        get: (property: string): string | null =>
          property === "font-family" ? sample.family : property === "font-weight" ? String(sample.weight) : null,
      };
      const metric = imageRootFontMetricUnits(declarations, sample.size, null);
      for (const unit of ["ex", "ch", "cap", "ic"]) {
        const value = metric?.(unit);
        expect(value, `${sample.family || "initial"} ${unit}`).not.toBeNull();
        expect(Math.abs((value ?? 0) - chrome[unit]), `${sample.family || "initial"} ${unit}`).toBeLessThan(0.01);
      }
    }
  } finally {
    await page.close();
    await browser.close();
  }
});
