import { afterAll, describe, expect, it } from "vitest";
import sharp from "sharp";

import {
  captureElementTree,
  captureElementTreeWithWarnings,
  elementTreeToSvgInner,
  launchChromium,
} from "../src/index.js";
import type { CapturedElement } from "../src/capture/types.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

async function setup() {
  try {
    return { browser: await launchChromium({ args: ["--enable-blink-features=AppearanceBase"] }) };
  } catch {
    return null;
  }
}
const env = await setup();
afterAll(async () => closeBrowserSafely(env?.browser), 15_000);
const describeBrowser = env == null ? describe.skip : describe;

function walk(nodes: CapturedElement[]): CapturedElement[] {
  return nodes.flatMap((node) => [node, ...walk(node.children ?? [])]);
}

function byId(tree: CapturedElement[], id: string): CapturedElement {
  return walk(tree).find((node) => node.animId === id)!;
}

async function colors(uri: string): Promise<Map<string, number>> {
  const decoded = await sharp(Buffer.from(uri.slice(uri.indexOf(",") + 1), "base64"))
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const result = new Map<string, number>();
  for (let offset = 0; offset < decoded.data.length; offset += 4) {
    if (decoded.data[offset + 3] === 0) continue;
    const key = `${decoded.data[offset]},${decoded.data[offset + 1]},${decoded.data[offset + 2]}`;
    result.set(key, (result.get(key) ?? 0) + 1);
  }
  return result;
}

describeBrowser("source-owned partial native-control decorations", () => {
  it("captures the real file button and keeps exact status text structural", async () => {
    const viewport = { width: 820, height: 360 };
    const page = await env!.browser.newPage({ viewport, deviceScaleFactor: 2 });
    try {
      await page.setContent(`<style>
        html,body{margin:0;background:white;font:18px Arial;color:rgb(19,37,61)}
        .file{position:absolute;left:40.25px;width:410px}
        #empty{top:30.5px} #multiple{top:92.25px} #vertical{top:154.5px;height:160px;writing-mode:vertical-rl;direction:rtl}
        #author{top:30.5px;left:500px;width:280px}
        #shadow::file-selector-button{box-shadow:7px 5px 0 rgb(220,30,92)}
        #author::file-selector-button{background:rgb(18,98,178);border:3px solid rgb(177,31,74);border-radius:9px}
      </style>
      <input class="file" id="empty" data-domotion-anim="file-empty" type="file">
      <input class="file" id="multiple" data-domotion-anim="file-multiple" type="file" multiple>
      <input class="file" id="vertical" data-domotion-anim="file-vertical" type="file">
      <input class="file" id="author" data-domotion-anim="file-author" type="file">`);
      await page.setInputFiles("#multiple", [
        { name: "alpha.txt", mimeType: "text/plain", buffer: Buffer.from("a") },
        { name: "beta.txt", mimeType: "text/plain", buffer: Buffer.from("b") },
      ]);
      const before = await page.screenshot({ omitBackground: true });
      const capture = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, ...viewport });
      const after = await page.screenshot({ omitBackground: true });
      expect(Buffer.compare(before, after)).toBe(0);
      expect(capture.warnings.filter(({ feature }) => feature === "native-control-decoration-raster")).toEqual([]);

      for (const id of ["file-empty", "file-multiple", "file-vertical"]) {
        const file = byId(capture.tree, id);
        expect(file.nativeControlDecorationRaster?.kinds).toEqual(["file-selector-button"]);
        expect(file.nativeControlDecorationRaster?.dataUri).toMatch(/^data:image\/png;base64,/);
        expect(file.nativeControlDecorationRaster?.sourceNodeIndex).toBeUndefined();
        expect(file.nativeControlDecorationRaster?.exactPartBox).toBeUndefined();
        expect(file.styles.fileSelectorButton?.text).toMatch(/^Choose File/);
        expect(file.styles.fileSelectorStatus?.text).not.toBe("");
      }
      expect(byId(capture.tree, "file-empty").styles.fileSelectorStatus?.text).toBe("No file chosen");
      expect(byId(capture.tree, "file-multiple").styles.fileSelectorStatus?.text).toBe("2 files");

      const authored = byId(capture.tree, "file-author");
      expect(authored.nativeControlDecorationRaster).toBeUndefined();
      expect(authored.styles.fileSelectorButton?.text).toMatch(/^Choose File/);
      expect(authored.styles.fileSelectorStatus?.text).toBe("No file chosen");

      const svg = elementTreeToSvgInner(capture.tree, viewport.width, viewport.height);
      const multiple = byId(capture.tree, "file-multiple");
      const imageAt = svg.indexOf(multiple.nativeControlDecorationRaster!.dataUri!);
      const statusAt = svg.indexOf('aria-label="2 files"');
      expect(imageAt).toBeGreaterThanOrEqual(0);
      expect(statusAt).toBeGreaterThan(imageAt);
      expect(svg).toContain("rgb(18, 98, 178)");
    } finally {
      await page.close();
    }
  }, 90_000);

  it("splits the complete/select/base routes and every closed-shadow input part", async () => {
    const viewport = { width: 940, height: 620 };
    const page = await env!.browser.newPage({ viewport, deviceScaleFactor: 2 });
    try {
      await page.setContent(`<style>
        html,body{margin:0;background:white;color-scheme:light dark}
        .grid{display:grid;grid-template-columns:repeat(3,280px);gap:14px;padding:20.25px}
        .split{width:250px;height:42px;background:rgb(13,71,109);border:3px solid rgb(149,31,73);
          box-shadow:0 0 0 3px rgb(31,149,73);color:white;padding:4px 15px}
        #search::-webkit-search-cancel-button{-webkit-appearance:none;opacity:1;width:18px;height:18px;background:rgb(121,21,122);border:0}
        #number::-webkit-inner-spin-button{-webkit-appearance:none;opacity:1;width:18px;background:rgb(19,119,20);border:0}
        #date-custom::-webkit-calendar-picker-indicator{-webkit-appearance:none;background:rgb(20,80,180)}
      </style><div class="grid">
        <select data-domotion-anim="native"><option>native menulist</option></select>
        <select class="split" data-domotion-anim="styled"><option>vector selected text</option></select>
        <select class="split" data-domotion-anim="base" style="appearance:base-select"><option>base select</option></select>
        <input class="split" data-domotion-anim="date" type="date" value="2026-08-22">
        <input class="split" data-domotion-anim="time" type="time" value="13:45">
        <input class="split" data-domotion-anim="datetime" type="datetime-local" value="2026-08-22T13:45">
        <input class="split" data-domotion-anim="month" type="month" value="2026-08">
        <input class="split" data-domotion-anim="week" type="week" value="2026-W34">
        <input class="split" data-domotion-anim="date-custom" id="date-custom" type="date" value="2026-08-22">
        <input class="split" data-domotion-anim="search" id="search" type="search" value="query">
        <input class="split" data-domotion-anim="number" id="number" type="number" value="42">
        <input class="split" data-domotion-anim="readonly" type="date" value="2026-08-22" readonly>
        <input class="split" data-domotion-anim="disabled" type="date" value="2026-08-22" disabled>
      </div>`);
      const before = await page.screenshot({ omitBackground: true });
      const capture = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, ...viewport });
      const after = await page.screenshot({ omitBackground: true });
      expect(Buffer.compare(before, after)).toBe(0);
      expect(capture.warnings.filter(({ feature }) => feature === "native-control-decoration-raster")).toEqual([]);

      expect(byId(capture.tree, "native").nativeControlRaster?.dataUri).toMatch(/^data:image\/png;base64,/);
      expect(byId(capture.tree, "native").nativeControlDecorationRaster).toBeUndefined();
      expect(byId(capture.tree, "base").styles.effectiveAppearance).toBe("base-select");
      expect(byId(capture.tree, "base").nativeControlDecorationRaster).toBeUndefined();

      const styled = byId(capture.tree, "styled");
      expect(styled.styles.effectiveAppearance).toBe("menulist-button");
      expect(styled.nativeControlRaster).toBeUndefined();
      expect(styled.nativeControlDecorationRaster?.kinds).toEqual(["menulist-button-arrow"]);
      expect(styled.nativeControlDecorationRaster?.dataUri).toMatch(/^data:image\/png;base64,/);

      for (const id of ["date", "time", "datetime", "month", "week", "date-custom"]) {
        const raster = byId(capture.tree, id).nativeControlDecorationRaster;
        expect(raster?.kinds).toEqual(["calendar-picker-indicator"]);
        expect(raster?.dataUri).toMatch(/^data:image\/png;base64,/);
        expect(raster?.sourceNodeIndex).toBeUndefined();
        expect(raster?.parts).toBeUndefined();
      }
      expect(byId(capture.tree, "search").nativeControlDecorationRaster?.kinds)
        .toEqual(["search-cancel-button"]);
      expect(byId(capture.tree, "number").nativeControlDecorationRaster?.kinds)
        .toEqual(["inner-spin-button"]);
      expect(byId(capture.tree, "search").nativeControlDecorationRaster?.dataUri).toMatch(/^data:image\/png;base64,/);
      expect(byId(capture.tree, "number").nativeControlDecorationRaster?.dataUri).toMatch(/^data:image\/png;base64,/);
      expect(byId(capture.tree, "readonly").nativeControlDecorationRaster?.empty).toBe(true);
      expect(byId(capture.tree, "disabled").nativeControlDecorationRaster?.empty).toBe(true);

      const arrowColors = await colors(styled.nativeControlDecorationRaster!.dataUri!);
      expect(arrowColors.get("13,71,109") ?? 0).toBe(0);
      expect(arrowColors.get("149,31,73") ?? 0).toBe(0);
      const searchColors = await colors(byId(capture.tree, "search").nativeControlDecorationRaster!.dataUri!);
      const numberColors = await colors(byId(capture.tree, "number").nativeControlDecorationRaster!.dataUri!);
      expect(searchColors.get("121,21,122") ?? 0).toBeGreaterThan(20);
      expect(numberColors.get("19,119,20") ?? 0).toBeGreaterThan(20);

      const svg = elementTreeToSvgInner(capture.tree, viewport.width, viewport.height);
      expect(svg).toContain("vector selected text");
      expect(svg.match(/<image href="data:image\/png;base64,/g)?.length ?? 0).toBeGreaterThanOrEqual(9);
    } finally {
      await page.close();
    }
  }, 90_000);

  it("retains platform paint across interaction, schemes, forced colors, axes, zoom, and DPR", async () => {
    const rows = [
      { dpr: 1, scheme: "light" as const, forced: "none" as const, writing: "horizontal-tb", direction: "ltr", zoom: "1" },
      { dpr: 2, scheme: "dark" as const, forced: "none" as const, writing: "horizontal-tb", direction: "rtl", zoom: "1.25" },
      { dpr: 2, scheme: "light" as const, forced: "active" as const, writing: "vertical-rl", direction: "rtl", zoom: ".85" },
      { dpr: 1, scheme: "dark" as const, forced: "none" as const, writing: "sideways-lr", direction: "ltr", zoom: "1.1" },
    ];
    for (const row of rows) {
      const context = await env!.browser.newContext({
        viewport: { width: 430, height: 260 }, deviceScaleFactor: row.dpr,
        colorScheme: row.scheme, forcedColors: "none",
      });
      const page = await context.newPage();
      try {
        await page.emulateMedia({ forcedColors: row.forced });
        await page.setContent(`<style>
          html,body{margin:0;color-scheme:light dark}
          .c{position:absolute;left:40.25px;width:280px;height:44px;background:rgb(231,238,247);
            border:2px solid rgb(45,65,85);writing-mode:${row.writing};direction:${row.direction};zoom:${row.zoom}}
          #select{top:24.5px} #search{top:92.25px} #number{top:160.5px}
        </style>
        <select class="c" id="select" data-domotion-anim="select"><option>axis state</option></select>
        <input class="c" id="search" data-domotion-anim="search" type="search" value="clear me">
        <input class="c" id="number" data-domotion-anim="number" type="number" value="7">`);

        const captureState = async () => captureElementTreeWithWarnings(
          page, "body", { x: 0, y: 0, width: 430, height: 260 },
        );
        const rest = await captureState();
        expect(rest.warnings.filter(({ feature }) => feature === "native-control-decoration-raster")).toEqual([]);
        expect(byId(rest.tree, "select").nativeControlDecorationRaster?.dataUri).toMatch(/^data:image\/png;base64,/);
        expect(byId(rest.tree, "search").nativeControlDecorationRaster?.empty).toBe(true);
        expect(byId(rest.tree, "number").nativeControlDecorationRaster?.empty).toBe(true);

        await page.focus("#search");
        const focused = await captureState();
        expect(byId(focused.tree, "search").nativeControlDecorationRaster?.dataUri).toMatch(/^data:image\/png;base64,/);
        await page.hover("#number");
        const hovered = await captureState();
        expect(byId(hovered.tree, "number").nativeControlDecorationRaster?.dataUri).toMatch(/^data:image\/png;base64,/);
        await page.mouse.down();
        const active = await captureState();
        expect(byId(active.tree, "number").nativeControlDecorationRaster?.dataUri).toMatch(/^data:image\/png;base64,/);
        await page.mouse.up();
      } finally {
        await page.mouse.up().catch(() => undefined);
        await context.close();
      }
    }
  }, 120_000);

  it("warns and suppresses sampled decoration when the atomic readback fails", async () => {
    const viewport = { width: 340, height: 180 };
    const page = await env!.browser.newPage({ viewport, deviceScaleFactor: 1 });
    try {
      await page.setContent(`<input style="appearance:none;width:1px;height:1px">`);
      await captureElementTree(page, "body", { x: 0, y: 0, ...viewport });
      await page.setContent(`<style>html,body{margin:0}select{margin:40px;width:220px;height:44px;background:red;border:2px solid blue}</style>
        <select data-domotion-anim="failed"><option>vector survives</option></select>`);
      (page as unknown as { screenshot: typeof page.screenshot }).screenshot = async () => {
        throw new Error("forced partial-decoration readback failure");
      };
      let capture: Awaited<ReturnType<typeof captureElementTreeWithWarnings>>;
      try {
        capture = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, ...viewport });
      } finally {
        delete (page as unknown as Record<string, unknown>).screenshot;
      }
      const warning = capture.warnings.find(({ feature }) => feature === "native-control-decoration-raster");
      expect(warning?.detail).toContain("atomic transparent isolation screenshot failed");
      expect(warning?.detail).toContain("sampled SVG decoration is suppressed");
      const raster = byId(capture.tree, "failed").nativeControlDecorationRaster!;
      expect(raster.dataUri).toBeUndefined();
      expect(raster.empty).toBeUndefined();
      expect(raster.sourceNodeIndex).toBeUndefined();
      const svg = elementTreeToSvgInner(capture.tree, viewport.width, viewport.height);
      expect(svg).toContain("vector survives");
      expect(svg).not.toContain("polyline");
      expect(svg).not.toContain("data:image/png;base64");
    } finally {
      delete (page as unknown as Record<string, unknown>).screenshot;
      await page.close();
    }
  }, 60_000);
});
