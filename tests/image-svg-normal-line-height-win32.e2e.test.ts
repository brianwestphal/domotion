import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";
import sharp from "sharp";
import { expect, it } from "vitest";
import { resolveFont } from "@domotion/text-engine/testing";
import { imageRootFontMetricUnits } from "../src/render/svg-image-root-font.js";
import { inlineImgSvg } from "../src/render/svg-inline.js";

it.skipIf(process.platform !== "win32")(
  "matches Windows Chromium normal lh for ordinary DirectWrite faces",
  async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    try {
      for (const family of ["Arial", "Segoe UI", "Georgia", "Consolas", "serif", "sans-serif", "system-ui"]) {
        for (const size of [13, 15.995, 16.005, 24]) {
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
          const declarations = {
            get: (property: string): string | null => (property === "font-family" ? family : null),
          };
          const rendered = imageRootFontMetricUnits(declarations, size, null)?.("lh");
          expect(rendered, `${family} ${size}px`).not.toBeNull();
          expect(Math.abs((rendered ?? 0) - chrome), `${family} ${size}px`).toBeLessThan(0.01);
        }
      }
    } finally {
      await page.close();
      await browser.close();
    }
  },
);

it.skipIf(process.platform !== "win32")(
  "matches Chromium lh and SVG image geometry for a discriminating bitmap/GDI helper face (DM-3ZRKA5)",
  async () => {
    const families = [
      "SimSun",
      "NSimSun",
      "MingLiU",
      "PMingLiU",
      "MS Gothic",
      "MS PGothic",
      "Gulim",
      "Dotum",
      "Batang",
    ];
    const sizes = [...Array.from({ length: 25 }, (_, index) => index + 8), 13.25, 15.995, 16.005];
    let selected: { family: string; size: number; face: string } | undefined;
    find: for (const family of families) {
      for (const size of sizes) {
        const font = resolveFont(JSON.stringify(family), 400, size);
        const metrics = font?.directWriteMetrics;
        if (
          font == null ||
          !font.embeddedBitmapPaint ||
          font.lineGap == null ||
          !Number.isFinite(font.lineGap) ||
          metrics?.measuringMode !== "gdi-classic" ||
          (font.ascent === metrics.ascent && font.descent === metrics.descent && font.lineGap === metrics.lineGap)
        )
          continue;
        // This instance has no hhea directory: its line spacing must come from
        // native size-specific evidence, even though a physical file may exist.
        expect(font.directory?.tables?.hhea).toBeUndefined();
        selected = { family, size, face: metrics.postscriptName };
        break find;
      }
    }
    expect(selected, "No installed bitmap face exposed distinct GDI metrics; rebuild the Windows helper").toBeDefined();
    const sample = selected!;
    console.info(`Windows lh bitmap control: ${sample.face} ${sample.size}px`);
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 220, height: 100 } });
    try {
      const chrome = await page.evaluate(({ family, size }) => {
        const div = document.createElement("div");
        div.style.cssText = `font-family:${JSON.stringify(family)};font-size:${size}px;line-height:normal;width:100lh;position:absolute`;
        document.body.append(div);
        const height = parseFloat(getComputedStyle(div).width) / 100;
        div.remove();
        return height;
      }, sample);
      const declarations = {
        get: (property: string): string | null => (property === "font-family" ? JSON.stringify(sample.family) : null),
      };
      const actual = imageRootFontMetricUnits(declarations, sample.size, null)?.("lh");
      expect(actual).not.toBeNull();
      expect(Math.abs((actual ?? 0) - chrome)).toBeLessThan(0.01);

      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><style>svg{font-family:${JSON.stringify(sample.family)};font-size:${sample.size}px;line-height:normal;transform:translateY(1lh);transform-origin:0 0}</style><rect width="12" height="12" fill="red"/></svg>`;
      const inlined = inlineImgSvg(svg, {
        x: 0,
        y: 0,
        w: 100,
        h: 100,
        par: "xMidYMid meet",
        documentViewport: true,
        idPrefix: "WinLh-",
      });
      expect(inlined).not.toBeNull();
      await page.setContent(
        `<body style="margin:0;background:white"><img width="100" height="100" src="data:image/svg+xml,${encodeURIComponent(svg)}" style="position:absolute;left:0;top:0"><svg width="100" height="100" style="position:absolute;left:110px;top:0">${inlined}</svg><span style="position:absolute;left:0;top:70px;font:10px Arial">Chromium image</span><span style="position:absolute;left:110px;top:70px;font:10px Arial">Domotion inline</span></body>`,
      );
      mkdirSync("tests/output", { recursive: true });
      const image = await sharp(await page.screenshot({ path: "tests/output/windows-image-root-line-height.png" }))
        .raw()
        .toBuffer({ resolveWithObject: true });
      const rgb = (x: number, y: number): number[] => {
        const at = (y * image.info.width + x) * image.info.channels;
        return Array.from(image.data.subarray(at, at + 3));
      };
      expect(rgb(4, 1)).toEqual([255, 255, 255]);
      expect(rgb(4, Math.ceil(chrome) + 4)).toEqual([255, 0, 0]);
      expect(rgb(114, Math.ceil(chrome) + 4)).toEqual(rgb(4, Math.ceil(chrome) + 4));
    } finally {
      await page.close();
      await browser.close();
    }
  },
  120_000,
);
