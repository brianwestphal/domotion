import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { Browser } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureElementTree, launchChromium } from "../src/capture/index.js";
import type { CapturedElement } from "../src/capture/types.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import { captureRealWorldReferenceFrame } from "./real-world-reference-frame.js";
import { WEBGL_FIXTURE_LAUNCH_ARGS } from "../src/test-support/webgl-fixture-launch.js";

let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium({ args: [...WEBGL_FIXTURE_LAUNCH_ARGS] });
});
afterAll(async () => {
  await closeBrowserSafely(browser);
});

function canvasOwner(nodes: CapturedElement[]): CapturedElement | undefined {
  for (const node of nodes) {
    if (node.tag === "canvas") return node;
    const found = canvasOwner(node.children ?? []);
    if (found) return found;
  }
  return undefined;
}

async function center(bytes: Buffer): Promise<number[]> {
  return [...(await sharp(bytes).removeAlpha().extract({ left: 16, top: 16, width: 1, height: 1 }).raw().toBuffer())];
}

describe("real-world frozen reference frame", () => {
  it("restores the freeze if saving the authoritative reference fails before handoff", async () => {
    const page = await browser.newPage({ viewport: { width: 80, height: 80 } });
    try {
      await page.setContent("<body>reference failure</body>");
      const original = await page.evaluateHandle(() => WebGLRenderingContext.prototype.clear);
      const screenshot = page.screenshot.bind(page);
      let screenshots = 0;
      page.screenshot = async (options) => {
        if (++screenshots === 2) throw new Error("controlled authoritative screenshot failure");
        return screenshot(options);
      };
      await expect(
        captureRealWorldReferenceFrame(page, {
          path: "unused-reference.png",
          clip: { x: 0, y: 0, width: 80, height: 80 },
          entirePage: false,
        }),
      ).rejects.toThrow("controlled authoritative screenshot failure");
      expect(await original.evaluate((method) => WebGLRenderingContext.prototype.clear === method)).toBe(true);
      await original.dispose();
    } finally {
      await page.close();
    }
  });

  for (const preserveDrawingBuffer of [false, true]) {
    it(`saves the presented frozen frame and preserves source state (buffer preservation ${preserveDrawingBuffer})`, async () => {
      const output = await mkdtemp(join(tmpdir(), "domotion-reference-"));
      const page = await browser.newPage({ viewport: { width: 80, height: 80 } });
      try {
        await page.setContent(
          '<style>body{margin:0}</style><canvas style="display: block;" width="32" height="32"></canvas>',
        );
        expect(
          await page.locator("canvas").evaluate((canvas: HTMLCanvasElement, preserve) => {
            const gl = canvas.getContext("webgl", { preserveDrawingBuffer: preserve });
            if (!gl) return false;
            gl.clearColor(1, 0, 0, 1);
            gl.clear(gl.COLOR_BUFFER_BIT);
            return !gl.isContextLost();
          }, preserveDrawingBuffer),
        ).toBe(true);
        const screenshot = page.screenshot.bind(page);
        let screenshots = 0;
        page.screenshot = async (options) => {
          const bytes = await screenshot(options);
          if (++screenshots === 1) {
            // A real draw between initial presentation and freeze is the
            // ordering discriminator: the old reference saved red here.
            expect(await center(bytes)).toEqual([255, 0, 0]);
            await page.locator("canvas").evaluate((canvas: HTMLCanvasElement) => {
              const gl = canvas.getContext("webgl")!;
              gl.clearColor(0, 0, 1, 1);
              gl.clear(gl.COLOR_BUFFER_BIT);
            });
          }
          return bytes;
        };
        const path = join(output, "expected.png");
        const { webGlFreeze } = await captureRealWorldReferenceFrame(page, {
          path,
          clip: { x: 0, y: 0, width: 80, height: 80 },
          entirePage: false,
        });
        expect(webGlFreeze.failedFrames).toBe(0);
        expect(await center(await readFile(path))).toEqual([0, 0, 255]);
        const source = await page.locator("canvas").evaluate((canvas) => canvas.outerHTML);
        const frozenMethod = await page.evaluateHandle(() => WebGLRenderingContext.prototype.clear);
        const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 80, height: 80 });
        const uri = canvasOwner(tree)?.replacedSnapshot?.dataUri;
        expect(uri).toBeDefined();
        expect(await center(Buffer.from(uri!.split(",")[1], "base64"))).toEqual([0, 0, 255]);
        expect(await frozenMethod.evaluate((method) => WebGLRenderingContext.prototype.clear === method)).toBe(true);
        expect(await page.locator("canvas").evaluate((canvas) => canvas.outerHTML)).toBe(source);
        await page.locator("canvas").evaluate((canvas: HTMLCanvasElement) => {
          const gl = canvas.getContext("webgl")!;
          gl.clearColor(0, 1, 0, 1);
          gl.clear(gl.COLOR_BUFFER_BIT);
        });
        expect(await center(await screenshot())).toEqual([0, 0, 255]);
        await frozenMethod.dispose();
      } finally {
        await page.close();
        await rm(output, { recursive: true, force: true });
      }
    });
  }
});
