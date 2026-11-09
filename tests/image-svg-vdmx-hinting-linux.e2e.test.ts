import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { buildVdmxHintedFont, clearGlyphHelperCache } from "@domotion/text-engine/testing";
import sharp from "sharp";
import { expect, it } from "vitest";
import { captureImageFontHinting, observeImageFontHinting } from "../src/capture/image-font-hinting.js";
import { captureElementTree, launchChromium } from "../src/capture/index.js";
import { imageRootFontMetricUnits } from "../src/render/svg-image-root-font.js";
import { inlineImgSvg } from "../src/render/svg-inline.js";
import { capturedElement } from "../src/test-support/captured-fixtures.js";

it.skipIf(process.platform !== "linux")(
  "discriminates launch hinting from per-face Fontconfig with a real VDMX strike",
  async () => {
    const priorConfig = process.env["FONTCONFIG_FILE"];
    const dir = mkdtempSync(join(tmpdir(), "domotion-vdmx-native-"));
    const results: Array<{ mode: string; singleProcess: boolean; observed?: string; lineSpacing: number }> = [];
    try {
      writeFileSync(join(dir, "control.ttf"), buildVdmxHintedFont());
      const config = join(dir, "fonts.conf");
      writeFileSync(
        config,
        `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd"><fontconfig>
      <dir>${dir}</dir><cachedir>${dir}/cache</cachedir>
      <match target="pattern"><edit name="hinting" mode="assign"><bool>true</bool></edit>
        <edit name="hintstyle" mode="assign"><const>hintmedium</const></edit>
        <edit name="autohint" mode="assign"><bool>false</bool></edit></match>
      <match target="font"><edit name="hinting" mode="assign"><bool>true</bool></edit>
        <edit name="hintstyle" mode="assign"><const>hintmedium</const></edit>
        <edit name="autohint" mode="assign"><bool>false</bool></edit></match>
      </fontconfig>`,
      );
      process.env["FONTCONFIG_FILE"] = config;
      clearGlyphHelperCache();
      for (const [mode, singleProcess] of [
        ["none", true],
        ["medium", true],
        ["none", false],
      ] as const) {
        // Explicit launch preferences; the unowned custom-launch control follows.
        const browser = await launchChromium({
          args: [`--font-render-hinting=${mode}`, ...(singleProcess ? ["--single-process"] : [])],
          env: { ...process.env, FONTCONFIG_FILE: config },
        });
        try {
          const page = await browser.newPage({ viewport: { width: 220, height: 150 } });
          const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" style="font-family:'Domotion VDMX Control';font-size:16px;line-height:normal;transform:translateY(1lh);transform-origin:0 0"><rect width="12" height="12" fill="red"/></svg>`;
          await page.setContent(
            `<div style="font-family:'Domotion VDMX Control';font-size:16px;line-height:normal;width:100lh">A</div><img id="vdmx-image" width="100" height="100" src="data:image/svg+xml,${encodeURIComponent(svg)}">`,
          );
          const lineSpacing = await page.locator("div").evaluate((el) => parseFloat(getComputedStyle(el).width) / 100);
          const observed = await observeImageFontHinting(page);
          results.push({ mode, singleProcess, observed, lineSpacing });
          expect(lineSpacing).toBe(singleProcess && mode === "none" ? 16 : 23);
          expect(observed).toBe(singleProcess ? mode : undefined);
          const tree = await captureElementTree(page, "#vdmx-image", { x: 0, y: 0, width: 220, height: 150 });
          const owner = tree.find((node) => node.imageSrc != null);
          expect(owner).toBeDefined();
          const fontRendering = owner?.imageDocumentFontRendering;
          expect(fontRendering).toBeDefined();
          const declarations = { get: (name: string) => (name === "font-family" ? "'Domotion VDMX Control'" : null) };
          expect(imageRootFontMetricUnits(declarations, 16, null, fontRendering)?.("lh")).toBe(lineSpacing);
          // Mechanism-off must become unresolved on this very same control.
          expect(imageRootFontMetricUnits(declarations, 16, null)?.("lh")).toBeNull();
          const inlined = inlineImgSvg(svg, {
            x: 0,
            y: 0,
            w: 100,
            h: 100,
            par: "none",
            documentViewport: true,
            idPrefix: "VDMX-",
            fontRendering,
          });
          expect(inlined).not.toBeNull();
          await page.setContent(
            `<body style="margin:0;background:white"><img width="100" height="100" src="data:image/svg+xml,${encodeURIComponent(svg)}"><svg width="100" height="100" style="position:absolute;left:110px;top:0">${inlined}</svg></body>`,
          );
          const output = resolve(process.env["DOMOTION_OUTPUT_DIR"] ?? "tests/output-linux");
          mkdirSync(output, { recursive: true });
          const image = await sharp(
            await page.screenshot({
              path: join(output, `image-vdmx-${mode}-${singleProcess ? "global" : "family"}.png`),
            }),
          )
            .raw()
            .toBuffer({ resolveWithObject: true });
          const rgb = (x: number, y: number) =>
            Array.from(
              image.data.subarray(
                (y * image.info.width + x) * image.info.channels,
                (y * image.info.width + x) * image.info.channels + 3,
              ),
            );
          expect(rgb(4, 1)).toEqual([255, 255, 255]);
          expect(rgb(4, lineSpacing + 4)).toEqual([255, 0, 0]);
          expect(rgb(114, lineSpacing + 4)).toEqual(rgb(4, lineSpacing + 4));
        } finally {
          await browser.close();
        }
      }
      const custom = await chromium.launch({
        args: ["--single-process", "--font-render-hinting=none"],
        env: { ...process.env },
      });
      try {
        const page = await custom.newPage();
        expect(await observeImageFontHinting(page)).toBe("none");
        const owner = capturedElement({ imageSrc: "data:image/svg+xml,<svg/>", children: [] });
        await captureImageFontHinting(page, [owner]);
        expect(owner.imageDocumentFontRendering).toBeUndefined();
      } finally {
        await custom.close();
      }
      expect(results[0]?.lineSpacing).not.toBe(results[1]?.lineSpacing);
      const output = resolve(process.env["DOMOTION_OUTPUT_DIR"] ?? "tests/output-linux");
      mkdirSync(output, { recursive: true });
      writeFileSync(
        join(output, "image-vdmx-hinting.json"),
        JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2),
      );
      console.log("Linux VDMX hinting control:", JSON.stringify(results));
    } finally {
      clearGlyphHelperCache();
      if (priorConfig == null) delete process.env["FONTCONFIG_FILE"];
      else process.env["FONTCONFIG_FILE"] = priorConfig;
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
