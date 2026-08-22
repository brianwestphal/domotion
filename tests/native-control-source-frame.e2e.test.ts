import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

async function setup() { try { return { browser: await launchChromium() }; } catch { return null; } }
const env = await setup();
afterAll(async () => closeBrowserSafely(env?.browser), 15_000);
const describeBrowser = env == null ? describe.skip : describe;

function walk(nodes: CapturedElement[]): CapturedElement[] {
  return nodes.flatMap((node) => [node, ...walk(node.children ?? [])]);
}

function png(uri: string): Buffer {
  return Buffer.from(uri.slice(uri.indexOf(",") + 1), "base64");
}

function digest(uri: string): string {
  return createHash("sha256").update(png(uri)).digest("hex");
}

async function rgba(input: Buffer | string) {
  return sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
}

async function sourceCrop(
  sourcePath: string,
  raster: NonNullable<CapturedElement["nativeControlRaster"]>,
  viewport: { width: number; height: number },
): Promise<Buffer> {
  const source = await rgba(sourcePath);
  const scaleX = source.info.width / viewport.width;
  const scaleY = source.info.height / viewport.height;
  expect(scaleX).toBeCloseTo(scaleY, 8);
  const left = Math.floor(raster.x * scaleX);
  const top = Math.floor(raster.y * scaleY);
  const right = Math.ceil((raster.x + raster.width) * scaleX);
  const bottom = Math.ceil((raster.y + raster.height) * scaleY);
  return sharp(sourcePath).extract({ left, top, width: right - left, height: bottom - top })
    .ensureAlpha().raw().toBuffer();
}

describeBrowser("source-frame coherent native-control rasters", () => {
  it("uses one atomic isolation readback and retains source-frame pixels for determinate, indeterminate, and meter paint", async () => {
    const viewport = { width: 420, height: 220 };
    const page = await env!.browser.newPage({ viewport, deviceScaleFactor: 2 });
    const directory = mkdtempSync(join(tmpdir(), "dm2456-source-"));
    const sourcePath = join(directory, "source.png");
    try {
      // Warm the page-scoped platform-resizer measurement before counting the
      // control pass' screenshots.
      await page.setContent(`<input style="appearance:none;width:1px;height:1px">`);
      await captureElementTree(page, "body", { x: 0, y: 0, ...viewport });
      await page.setContent(`<style>
        html,body{margin:0;background:rgb(247,244,238)}
        progress,meter{display:block;margin:22px;width:230px;height:18px}
      </style>
      <progress id="indeterminate"></progress>
      <progress id="determinate" value="0.43"></progress>
      <meter id="meter" min="0" max="1" low=".3" high=".7" value=".82"></meter>`);
      await page.waitForTimeout(120);
      await page.screenshot({ path: sourcePath });

      const originalScreenshot = page.screenshot.bind(page);
      let screenshots = 0;
      (page as unknown as { screenshot: typeof page.screenshot }).screenshot = async (options) => {
        screenshots++;
        // Force the native indeterminate segment to advance far enough that a
        // per-control post-capture screenshot would be observably stale.
        await page.waitForTimeout(180);
        return originalScreenshot(options as never) as ReturnType<typeof page.screenshot>;
      };
      let capture: Awaited<ReturnType<typeof captureElementTreeWithWarnings>>;
      try {
        capture = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, ...viewport }, {
          rasterizeFromImagePath: sourcePath,
        });
      } finally {
        delete (page as unknown as Record<string, unknown>).screenshot;
      }

      expect(screenshots).toBe(1);
      expect(capture.warnings.filter((warning) => warning.feature === "native-control-raster")).toEqual([]);
      const controls = walk(capture.tree).filter((node) => node.nativeControlRaster != null);
      expect(controls.map((node) => node.tag)).toEqual(["progress", "progress", "meter"]);
      for (const [index, control] of controls.entries()) {
        const raster = control.nativeControlRaster!;
        expect(raster.dataUri).toMatch(/^data:image\/png;base64,/);
        expect(raster.sourceNodeIndex).toBeUndefined();
        expect(raster.frameSensitive).toBeUndefined();
        const actual = await rgba(png(raster.dataUri!));
        const source = await sourceCrop(sourcePath, raster, viewport);
        expect(actual.data.length).toBe(source.length);
        let compared = 0;
        let mismatch = 0;
        for (let offset = 0; offset < actual.data.length; offset += 4) {
          if (actual.data[offset + 3] !== 255) continue;
          compared++;
          if (actual.data[offset] !== source[offset]
              || actual.data[offset + 1] !== source[offset + 1]
              || actual.data[offset + 2] !== source[offset + 2]) mismatch++;
        }
        expect(compared).toBeGreaterThan(100);
        expect(mismatch).toBe(0);
        if (index === 0) {
          // Indeterminate progress is the frame-sensitive owner. Its complete
          // crop, including every alpha byte, must be the authoritative source
          // frame—not a source/late-isolation mixture.
          expect(Buffer.compare(actual.data, source)).toBe(0);
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
      await page.close();
    }
  }, 60_000);

  it("captures native rest, hover, and active state from the current platform theme", async () => {
    const viewport = { width: 300, height: 180 };
    const page = await env!.browser.newPage({ viewport, deviceScaleFactor: 1 });
    try {
      await page.setContent(`<style>html,body{margin:0}#state{position:absolute;left:60px;top:45px;width:120px;height:38px}</style><button id="state">Platform state</button>`);
      const capture = async (): Promise<string> => {
        const result = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, ...viewport });
        expect(result.warnings.filter((warning) => warning.feature === "native-control-raster")).toEqual([]);
        return walk(result.tree).find((node) => node.tag === "button")!.nativeControlRaster!.dataUri!;
      };
      const rest = await capture();
      await page.hover("#state");
      const hover = await capture();
      await page.mouse.down();
      const active = await capture();
      await page.mouse.up();
      expect(rest).toMatch(/^data:image\/png;base64,/);
      expect(hover).toMatch(/^data:image\/png;base64,/);
      expect(active).toMatch(/^data:image\/png;base64,/);
      expect(new Set([digest(rest), digest(hover), digest(active)]).size).toBeGreaterThan(1);
    } finally {
      await page.mouse.up().catch(() => undefined);
      await page.close();
    }
  }, 60_000);

  it("keeps checkbox/radio alpha isolated from page backgrounds and overlapping positioned paint", async () => {
    const viewport = { width: 300, height: 180 };
    const page = await env!.browser.newPage({ viewport, deviceScaleFactor: 1 });
    const directory = mkdtempSync(join(tmpdir(), "dm2456-alpha-"));
    const sourcePath = join(directory, "source.png");
    try {
      await page.setContent(`<style>
        html,body{margin:0;background:rgb(1,254,2)}
        input{position:absolute;width:28px;height:28px;accent-color:rgb(208,24,93)}
        #check{left:45px;top:55px} #radio{left:120px;top:55px}
        #overlap{position:absolute;left:35px;top:48px;width:130px;height:20px;background:rgb(254,1,253);z-index:5}
        #moving{position:absolute;left:45px;top:115px;width:160px;height:14px}
        #moving-overlap{position:absolute;left:90px;top:112px;width:40px;height:20px;background:rgb(254,1,253);z-index:5}
      </style><input id="check" type="checkbox" checked><input id="radio" type="radio" checked><div id="overlap"></div>
      <progress id="moving"></progress><div id="moving-overlap"></div>`);
      await page.screenshot({ path: sourcePath });
      const capture = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, ...viewport }, {
        rasterizeFromImagePath: sourcePath,
      });
      const warnings = capture.warnings.filter((warning) => warning.feature === "native-control-raster");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({ selector: "progress#moving" });
      expect(warnings[0].detail).toContain("one overlap-free source frame");
      const allControls = walk(capture.tree).filter((node) => node.nativeControlRaster != null);
      expect(allControls.find((node) => node.tag === "progress")?.nativeControlRaster?.dataUri).toBeUndefined();
      const controls = allControls.filter((node) => node.tag === "input");
      expect(controls).toHaveLength(2);
      for (const control of controls) {
        const decoded = await rgba(png(control.nativeControlRaster!.dataUri!));
        let transparent = 0;
        let leakedBackdrop = 0;
        for (let offset = 0; offset < decoded.data.length; offset += 4) {
          if (decoded.data[offset + 3] === 0) transparent++;
          if (decoded.data[offset + 3] !== 0
              && (decoded.data[offset] === 1 && decoded.data[offset + 1] === 254 && decoded.data[offset + 2] === 2
                || decoded.data[offset] === 254 && decoded.data[offset + 1] === 1 && decoded.data[offset + 2] === 253)) {
            leakedBackdrop++;
          }
        }
        expect(transparent).toBeGreaterThan(0);
        expect(leakedBackdrop).toBe(0);
      }
      const svg = elementTreeToSvgInner(capture.tree, viewport.width, viewport.height);
      expect(svg.match(/data:image\/png;base64/g)).toHaveLength(2);
      expect(svg).toContain("rgb(254,1,253)");
    } finally {
      rmSync(directory, { recursive: true, force: true });
      await page.close();
    }
  }, 60_000);

  it("preserves outline paint overflow through viewport clipping, scroll, fractional zoom, and DPR", async () => {
    const viewport = { width: 320, height: 180 };
    const page = await env!.browser.newPage({ viewport, deviceScaleFactor: 2 });
    const directory = mkdtempSync(join(tmpdir(), "dm2456-geometry-"));
    const sourcePath = join(directory, "source.png");
    try {
      await page.setContent(`<style>
        html,body{margin:0;background:white}body{height:800px}
        input{position:absolute;width:22.5px;height:22.5px;outline:4px solid rgb(19,177,91);outline-offset:2px}
        #left{left:-4.25px;top:218.5px;zoom:1.25}
        #right{left:285.5px;top:328.25px;zoom:1.1}
      </style><input id="left" type="checkbox" checked><input id="right" type="radio" checked>`);
      await page.evaluate(() => scrollTo(0, 200));
      const expected = await page.locator("input").evaluateAll((inputs) => inputs.map((input) => {
        const rect = input.getBoundingClientRect();
        const style = getComputedStyle(input);
        const expansion = Math.max(0, Number.parseFloat(style.outlineWidth) + Number.parseFloat(style.outlineOffset)) + 1;
        const left = Math.max(0, Math.floor(rect.left - expansion));
        const top = Math.max(0, Math.floor(rect.top - expansion));
        const right = Math.min(innerWidth, Math.ceil(rect.right + expansion));
        const bottom = Math.min(innerHeight, Math.ceil(rect.bottom + expansion));
        return { id: input.id, x: left, y: top, width: right - left, height: bottom - top };
      }));
      await page.screenshot({ path: sourcePath });
      const capture = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, ...viewport }, {
        rasterizeFromImagePath: sourcePath,
      });
      expect(capture.warnings.filter((warning) => warning.feature === "native-control-raster")).toEqual([]);
      const controls = walk(capture.tree).filter((node) => node.nativeControlRaster != null);
      expect(controls).toHaveLength(2);
      for (let index = 0; index < controls.length; index++) {
        const raster = controls[index].nativeControlRaster!;
        const { id: _id, ...expectedRect } = expected[index];
        expect({ x: raster.x, y: raster.y, width: raster.width, height: raster.height }).toEqual(expectedRect);
        const metadata = await sharp(png(raster.dataUri!)).metadata();
        expect(metadata.width).toBe(raster.width * 2);
        expect(metadata.height).toBe(raster.height * 2);
      }
      expect(controls[0].nativeControlRaster!.x).toBe(0);
      expect(controls[1].nativeControlRaster!.x + controls[1].nativeControlRaster!.width).toBe(viewport.width);
      expect(await page.evaluate(() => scrollY)).toBe(200);
    } finally {
      rmSync(directory, { recursive: true, force: true });
      await page.close();
    }
  }, 60_000);

  it("warns and emits no sampled chrome when both source and isolation screenshots fail", async () => {
    const viewport = { width: 240, height: 160 };
    const page = await env!.browser.newPage({ viewport, deviceScaleFactor: 1 });
    try {
      await page.setContent(`<input style="appearance:none;width:1px;height:1px">`);
      await captureElementTree(page, "body", { x: 0, y: 0, ...viewport });
      await page.setContent(`<input id="required" type="checkbox" checked style="position:absolute;left:40px;top:40px;width:24px;height:24px">`);
      (page as unknown as { screenshot: typeof page.screenshot }).screenshot = async () => {
        throw new Error("forced DM-2456 screenshot failure");
      };
      let capture: Awaited<ReturnType<typeof captureElementTreeWithWarnings>>;
      try {
        capture = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, ...viewport });
      } finally {
        delete (page as unknown as Record<string, unknown>).screenshot;
      }
      const warning = capture.warnings.find((entry) => entry.feature === "native-control-raster");
      expect(warning).toMatchObject({ selector: "input#required" });
      expect(warning?.detail).toContain("atomic isolated screenshot failed");
      expect(warning?.detail).toContain("sampled SVG chrome is suppressed");
      const raster = walk(capture.tree).find((node) => node.tag === "input")!.nativeControlRaster!;
      expect(raster.dataUri).toBeUndefined();
      expect(raster.empty).toBeUndefined();
      expect(raster.sourceNodeIndex).toBeUndefined();
      const svg = elementTreeToSvgInner(capture.tree, viewport.width, viewport.height);
      expect(svg).not.toMatch(/<(?:image|rect|circle|path)\b/);
    } finally {
      delete (page as unknown as Record<string, unknown>).screenshot;
      await page.close();
    }
  }, 60_000);
});
