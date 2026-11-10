import type { Browser } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { captureElementTree, launchChromium } from "../src/capture/index.js";
import type { CaptureWarning } from "../src/capture/types.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import { flattenImgSvg, inlineImgSvg, withFlattenNestedSvg } from "../src/render/svg-inline.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(async () => closeBrowserSafely(browser), 15_000);
const placement = { x: 0, y: 0, w: 100, h: 80, par: "none", documentViewport: true, idPrefix: "fallback-" };
const source = (css: string, sheet = "", attrs = ""): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80" xml:lang="en" transform="translate(30)" ${attrs} style="${css}">${sheet ? `<style>${sheet}</style>` : ""}<rect x="20" y="20" width="10" height="10" fill="red"/></svg>`;

describe.each([false, true])("SVG root source-paint ownership (flatten=%s)", (flatten) => {
  it.each([
    { name: "transform viewport unit", css: "transform:translateX(10dvw)" },
    { name: "individual translate", css: "translate:10dvw 0" },
    { name: "CSS transform origin", css: "transform:scale(2);transform-origin:10dvw 0" },
    { name: "origin presentation attribute", css: "transform:scale(2)", attrs: 'transform-origin="10dvw 0"' },
    { name: "individual scale math", css: "scale:calc(1 + abs(-1))" },
    { name: "individual rotate math", css: "rotate:atan2(1,1)" },
    { name: "undecidable root selector", css: "", sheet: "svg:lang(en){transform:translateX(5px)}" },
  ])("keeps source raster for $name", async (entry) => {
    const original = source(entry.css, "sheet" in entry ? entry.sheet : "", "attrs" in entry ? entry.attrs : "");
    const page = await browser.newPage({ viewport: { width: 100, height: 80 }, deviceScaleFactor: 1 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(
        await page.evaluate(
          (css) =>
            css
              .split(";")
              .filter(Boolean)
              .every((value) => CSS.supports(value)),
          entry.css,
        ),
      ).toBe(true);
      expect(inlineImgSvg(original, placement)).toBeNull();
      expect(flattenImgSvg(original, placement)).toBeNull();
      await page.setContent(
        `<body style="margin:0;background:white"><div id="target"><img src="data:image/svg+xml,${encodeURIComponent(original)}" style="display:block;width:100px;height:80px"></div></body>`,
      );
      const native = await sharp(await page.locator("img").screenshot())
        .raw()
        .toBuffer();
      const tree = await captureElementTree(page, "#target", { x: 0, y: 0, width: 100, height: 80 });
      const warnings: CaptureWarning[] = [];
      const output = withFlattenNestedSvg(flatten, () => elementTreeToSvg(tree, 100, 80, { warnings }));
      expect(output).toContain("<image ");
      expect(output).toMatch(/href="data:image\/svg\+xml/);
      expect(output).not.toContain("data-domotion-image-root");
      expect(
        warnings.some(
          (warning) => warning.feature === "svg-image-root-transform" && warning.detail.includes("raster fallback"),
        ),
      ).toBe(true);
      await page.setContent(
        `<body style="margin:0;background:white"><img src="data:image/svg+xml,${encodeURIComponent(output)}" style="display:block;width:100px;height:80px"></body>`,
      );
      const actual = await sharp(await page.locator("img").screenshot())
        .raw()
        .toBuffer();
      expect(actual.equals(native), "emitted pixels must equal the native SVG image").toBe(true);
    } finally {
      warn.mockRestore();
      await page.close();
    }
  });

  it.each([
    "transform:translateX(10px)",
    "transform:scale(1.5);transform-origin:20px 20px",
    "transform:translateZ(10px) translateX(5px)",
  ])("preserves exact vector lowering for %s", async (css) => {
    const original = source(css);
    const inline = flatten ? flattenImgSvg(original, placement) : inlineImgSvg(original, placement);
    expect(inline).not.toBeNull();
    const page = await browser.newPage({ viewport: { width: 100, height: 80 }, deviceScaleFactor: 1 });
    try {
      await page.setContent(
        `<body style="margin:0;background:white"><div id="target"><img src="data:image/svg+xml,${encodeURIComponent(original)}" style="display:block;width:100px;height:80px"></div></body>`,
      );
      const native = await sharp(await page.locator("img").screenshot())
        .raw()
        .toBuffer();
      const tree = await captureElementTree(page, "#target", { x: 0, y: 0, width: 100, height: 80 });
      const warnings: CaptureWarning[] = [];
      const output = withFlattenNestedSvg(flatten, () => elementTreeToSvg(tree, 100, 80, { warnings }));
      expect(output).not.toContain("<image ");
      expect(warnings.filter((warning) => warning.feature === "svg-image-root-transform")).toEqual([]);
      await page.setContent(
        `<body style="margin:0;background:white"><img src="data:image/svg+xml,${encodeURIComponent(output)}" style="display:block;width:100px;height:80px"></body>`,
      );
      const actual = await sharp(await page.locator("img").screenshot())
        .raw()
        .toBuffer();
      expect(actual.equals(native), "emitted pixels must equal the native SVG image").toBe(true);
    } finally {
      await page.close();
    }
  });
});
