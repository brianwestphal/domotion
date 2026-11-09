import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { buildVdmxHintedFont, clearGlyphHelperCache } from "@domotion/text-engine/testing";
import sharp from "sharp";
import { expect, it, vi } from "vitest";
import { captureImageFontHinting } from "../src/capture/image-font-hinting.js";
import { captureElementTree, launchChromium } from "../src/capture/index.js";
import { imageRootFontMetricUnits } from "../src/render/svg-image-root-font.js";
import { inlineImgSvg } from "../src/render/svg-inline.js";
import type { CapturedElement } from "../src/capture/types.js";
import { forEachElement } from "../src/tree-ops/for-each-element.js";
import { capturedElement } from "../src/test-support/captured-fixtures.js";

it.skipIf(process.platform !== "linux")(
  "discriminates launch hinting from per-face Fontconfig with a real VDMX strike",
  async () => {
    const priorConfig = process.env["FONTCONFIG_FILE"];
    const priorGenericProbe = process.env["DOMOTION_GENERIC_PROBE"];
    // This deliberately single-font inventory cannot answer unrelated generic
    // discovery probes. The named control uses no generic-family settings.
    process.env["DOMOTION_GENERIC_PROBE"] = "0";
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
          expect(lineSpacing).toBe(singleProcess && mode === "none" ? 16 : 23);
          const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 220, height: 150 });
          let owner: CapturedElement | undefined;
          const routing: Array<{
            tag: string;
            children: number;
            image: boolean;
            snapshot: boolean;
            inline: boolean;
            annotated: boolean;
          }> = [];
          forEachElement(tree, (node) => {
            routing.push({
              tag: node.tag,
              children: node.children.length,
              image: node.imageSrc != null,
              snapshot: node.replacedSnapshot != null,
              inline: node.svgContent != null,
              annotated: node.imageDocumentFontRendering != null,
            });
            if (node.imageSrc === `data:image/svg+xml,${encodeURIComponent(svg)}`) owner = node;
          });
          console.log("VDMX captured routing:", JSON.stringify({ mode, singleProcess, roots: tree.length, routing }));
          expect(owner).toBeDefined();
          expect(owner?.imageIntrinsic).toEqual({ w: 100, h: 100 });
          expect(owner?.replacedSnapshot).toBeUndefined();
          const fontRendering = owner?.imageDocumentFontRendering;
          expect(fontRendering).toBeDefined();
          expect(fontRendering).toMatchObject({ source: "shared-fontconfig-v1", singleProcess });
          const observed = fontRendering?.launchHinting;
          results.push({ mode, singleProcess, observed, lineSpacing });
          expect(observed).toBe(singleProcess ? mode : undefined);
          if (singleProcess && mode === "none") {
            // Exercise the production annotation path across a transient CDP
            // capability failure, not a separate launch-only observer/cache.
            const retryTree = structuredClone(tree);
            forEachElement(retryTree, (node) => {
              delete node.imageDocumentFontRendering;
            });
            const denied = vi
              .spyOn(page.context(), "newCDPSession")
              .mockRejectedValueOnce(new Error("controlled unavailable CDP capability"));
            try {
              await captureImageFontHinting(page, retryTree);
              expect(denied).toHaveBeenCalledOnce();
              forEachElement(retryTree, (node) => expect(node.imageDocumentFontRendering).toBeUndefined());
            } finally {
              denied.mockRestore();
            }
            await captureImageFontHinting(page, retryTree);
            let recovered = false;
            forEachElement(retryTree, (node) => {
              if (node.imageSrc === owner?.imageSrc) recovered = node.imageDocumentFontRendering != null;
            });
            expect(recovered).toBe(true);
          }
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
      if (priorGenericProbe == null) delete process.env["DOMOTION_GENERIC_PROBE"];
      else process.env["DOMOTION_GENERIC_PROBE"] = priorGenericProbe;
      if (priorConfig == null) delete process.env["FONTCONFIG_FILE"];
      else process.env["FONTCONFIG_FILE"] = priorConfig;
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
