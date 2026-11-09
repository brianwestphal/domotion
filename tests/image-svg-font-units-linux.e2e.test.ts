import { chromium } from "@playwright/test";
import { expect, it } from "vitest";
import { imageRootFontMetricUnits } from "../src/render/svg-image-root-font.js";

it.skipIf(process.platform !== "linux")("matches Linux Chromium SVG root ex/ch/cap/ic units", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const mismatches: string[] = [];
  try {
    for (const sample of [
      { family: "", size: 20, weight: 400 },
      { family: "serif", size: 16, weight: 700 },
      { family: "monospace", size: 12, weight: 400 },
      { family: "DejaVu Sans, sans-serif", size: 24, weight: 400 },
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
        if (value == null || Math.abs(value - chrome[unit]) >= 0.01) {
          mismatches.push(`${sample.family || "initial"} ${sample.size}px ${unit}: ${value} vs ${chrome[unit]}`);
        }
      }
    }
  } finally {
    await page.close();
    await browser.close();
  }
  expect(mismatches).toEqual([]);
});

it.skipIf(process.platform !== "linux")("matches Linux Chromium heights with font hinting disabled", async () => {
  const browser = await chromium.launch({ args: ["--font-render-hinting=none"] });
  const page = await browser.newPage();
  try {
    const heights = await page.evaluate(() => {
      const result: Record<string, number> = {};
      for (const unit of ["ex", "cap"]) {
        const div = document.createElement("div");
        div.style.cssText = `font-family:monospace;font-size:12px;width:100${unit};position:absolute`;
        document.body.append(div);
        result[unit] = parseFloat(getComputedStyle(div).width) / 100;
        div.remove();
      }
      return result;
    });
    const declarations = {
      get: (property: string): string | null => (property === "font-family" ? "monospace" : null),
    };
    const metric = imageRootFontMetricUnits(declarations, 12, null);
    for (const unit of ["ex", "cap"]) {
      expect(Math.abs((metric?.(unit) ?? 0) - heights[unit]), `monospace 12px ${unit}`).toBeLessThan(0.01);
    }
  } finally {
    await page.close();
    await browser.close();
  }
});
