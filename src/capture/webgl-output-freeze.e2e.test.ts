import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import type { Browser, Page } from "@playwright/test";
import { closeBrowserSafely } from "../test-support/close-browser-safely.js";
import { captureElementTree, launchChromium } from "./index.js";
import { evaluateInFrame } from "./evaluate-in-frame.js";
import { freezeWebGlOutputForCapture } from "./webgl-output-freeze.js";
import type { CapturedElement } from "./types.js";

let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(async () => {
  await closeBrowserSafely(browser);
});

async function makeWebGlPage(
  waitForPresentation = true,
  ownerBrowser = browser,
  preserveDrawingBuffer = true,
): Promise<Page> {
  const page = await ownerBrowser.newPage({ viewport: { width: 80, height: 80 } });
  await page.setContent('<canvas width="32" height="32"></canvas>');
  const supported = await evaluateInFrame(
    page,
    (preserve) => {
      const canvas = document.querySelector("canvas");
      const gl = canvas?.getContext("webgl", { preserveDrawingBuffer: preserve });
      if (gl == null) return false;
      gl.clearColor(1, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return gl.getContextAttributes()?.preserveDrawingBuffer === preserve;
    },
    preserveDrawingBuffer,
  );
  expect(supported).toBe(true);
  if (waitForPresentation) {
    try {
      await expect.poll(() => centerPixel(page), { timeout: 15_000 }).toEqual([255, 0, 0]);
    } catch (error) {
      // Diagnose startup separately from freeze: this runs before any method
      // is muted. Compare compositor output with the actual drawing buffer.
      const fullFrame = await page.screenshot();
      const presented = Array.from(
        await sharp(fullFrame).extract({ left: 20, top: 20, width: 1, height: 1 }).removeAlpha().raw().toBuffer(),
      );
      const drawingBuffer = await page.evaluate(() => {
        const canvas = document.querySelector("canvas")!;
        const gl = canvas.getContext("webgl")!;
        const pixel = new Uint8Array(4);
        gl.readPixels(16, 16, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        return {
          contextLost: gl.isContextLost(),
          error: gl.getError(),
          pixel: Array.from(pixel),
          bounds: canvas.getBoundingClientRect().toJSON(),
          visibility: document.visibilityState,
        };
      });
      await page.close();
      throw new Error(`WebGL startup presentation failed: ${JSON.stringify({ presented, drawingBuffer })}`, {
        cause: error,
      });
    }
  }
  return page;
}

async function centerPixel(page: Page): Promise<number[]> {
  const png = await page.screenshot({ clip: { x: 20, y: 20, width: 1, height: 1 } });
  // DM-D5JEMG: inspect Chromium's actual PNG, without another GPU bitmap
  // decode/readback in the same browser whose compositor is being tested.
  return Array.from(await sharp(png).removeAlpha().raw().toBuffer());
}

async function paint(page: Page, red: number, blue: number): Promise<void> {
  await evaluateInFrame(
    page,
    ({ red, blue }) => {
      const gl = document.querySelector("canvas")?.getContext("webgl", { preserveDrawingBuffer: true });
      if (gl == null) throw new Error("WebGL context unavailable");
      gl.clearColor(red, 0, blue, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    },
    { red, blue },
  );
}

function walk(nodes: CapturedElement[]): CapturedElement[] {
  return nodes.flatMap((node) => [node, ...walk(node.children ?? [])]);
}

async function capturedCanvasPixel(page: Page): Promise<number[]> {
  const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 80, height: 80 });
  const uri = walk(tree).find((node) => node.tag === "canvas")?.replacedSnapshot?.dataUri;
  expect(uri).toMatch(/^data:image\/png;base64,/);
  return Array.from(
    await sharp(Buffer.from(uri!.split(",")[1], "base64"))
      .extract({ left: 16, top: 16, width: 1, height: 1 })
      .removeAlpha()
      .raw()
      .toBuffer(),
  );
}

describe("capture-scoped WebGL output freeze", () => {
  it.each([true, false])(
    "captures a cold canvas before presentation polling (preserveDrawingBuffer=%s)",
    async (preserve) => {
      // Keep the original startup poll cold too: the production capture must
      // not initialize the browser used by the other presentation controls.
      const coldBrowser = await launchChromium();
      try {
        const page = await makeWebGlPage(false, coldBrowser, preserve);
        expect(await capturedCanvasPixel(page)).toEqual([255, 0, 0]);
        await paint(page, 0, 1);
        expect(await centerPixel(page)).toEqual([0, 0, 255]);
      } finally {
        await closeBrowserSafely(coldBrowser);
      }
    },
  );

  it("holds the presented pixels and restores drawing after disposal", async () => {
    const page = await makeWebGlPage();
    try {
      const frozen = await freezeWebGlOutputForCapture(page);
      expect(frozen.frozenFrames).toBe(1);
      try {
        await paint(page, 0, 1);
        const presented = await centerPixel(page);
        try {
          expect(presented).toEqual([255, 0, 0]);
        } catch (error) {
          // If held presentation fails, also inspect the production raster
          // under the same freeze instead of guessing whether it is affected.
          const captured = await capturedCanvasPixel(page).catch((failure: unknown) =>
            failure instanceof Error ? failure.message : String(failure),
          );
          throw new Error(`WebGL frozen presentation failed: ${JSON.stringify({ presented, captured })}`, {
            cause: error,
          });
        }
      } finally {
        await frozen.dispose();
      }
      await paint(page, 0, 1);
      expect(await centerPixel(page)).toEqual([0, 0, 255]);
    } finally {
      await page.close();
    }
  });

  it("freezes a canvas in a live child frame", async () => {
    const page = await browser.newPage({ viewport: { width: 80, height: 80 } });
    try {
      await page.setContent(
        `<body style="margin:0"><iframe style="border:0" width="32" height="32" srcdoc="<body style='margin:0'><canvas width='32' height='32'></canvas></body>"></iframe></body>`,
      );
      const child = page.frames().find((frame) => frame !== page.mainFrame());
      expect(child).toBeDefined();
      await child!.waitForSelector("canvas");
      const draw = async (red: number, blue: number): Promise<void> => {
        await evaluateInFrame(
          child!,
          ({ red, blue }) => {
            const gl = document.querySelector("canvas")?.getContext("webgl", { preserveDrawingBuffer: true });
            if (gl == null) throw new Error("WebGL context unavailable in child frame");
            gl.clearColor(red, 0, blue, 1);
            gl.clear(gl.COLOR_BUFFER_BIT);
          },
          { red, blue },
        );
      };
      await draw(1, 0);
      expect(await centerPixel(page)).toEqual([255, 0, 0]);
      const frozen = await freezeWebGlOutputForCapture(page);
      expect(frozen.frozenFrames).toBe(1);
      expect(frozen.failedFrames).toBe(0);
      try {
        await draw(0, 1);
        expect(await centerPixel(page)).toEqual([255, 0, 0]);
      } finally {
        await frozen.dispose();
      }
      await draw(0, 1);
      expect(await centerPixel(page)).toEqual([0, 0, 255]);
    } finally {
      await page.close();
    }
  });

  it("keeps drawing paused until nested captures both dispose", async () => {
    const page = await makeWebGlPage();
    try {
      const first = await freezeWebGlOutputForCapture(page);
      const second = await freezeWebGlOutputForCapture(page);
      try {
        await first.dispose();
        await paint(page, 0, 1);
        expect(await centerPixel(page)).toEqual([255, 0, 0]);
      } finally {
        await second.dispose();
      }
      await paint(page, 0, 1);
      expect(await centerPixel(page)).toEqual([0, 0, 255]);
    } finally {
      await page.close();
    }
  });

  it("captures the held red raster while draw attempts continue and restores blue afterward", async () => {
    const page = await makeWebGlPage();
    try {
      await page.evaluate(() => {
        const gl = document.querySelector("canvas")!.getContext("webgl", { preserveDrawingBuffer: true })!;
        const originalClear = gl.clear;
        const scope = globalThis as typeof globalThis & { frozenDrawAttempts: number; stopDrawLoop?: () => void };
        scope.frozenDrawAttempts = 0;
        let stopped = false;
        scope.stopDrawLoop = () => {
          stopped = true;
        };
        const attempt = (): void => {
          if (stopped) return;
          if (gl.clear !== originalClear) {
            scope.frozenDrawAttempts++;
            gl.clearColor(0, 0, 1, 1);
            gl.clear(gl.COLOR_BUFFER_BIT);
          }
          requestAnimationFrame(attempt);
        };
        requestAnimationFrame(attempt);
      });
      for (let capture = 0; capture < 3; capture++) {
        expect(await capturedCanvasPixel(page)).toEqual([255, 0, 0]);
      }
      expect(
        await page.evaluate(
          () => (globalThis as typeof globalThis & { frozenDrawAttempts: number }).frozenDrawAttempts,
        ),
      ).toBeGreaterThan(0);
      await page.evaluate(() => (globalThis as typeof globalThis & { stopDrawLoop?: () => void }).stopDrawLoop?.());
      await paint(page, 0, 1);
      expect(await centerPixel(page)).toEqual([0, 0, 255]);
    } finally {
      await page.close();
    }
  });

  it("restores WebGL methods when the tree capture fails", async () => {
    const page = await makeWebGlPage();
    try {
      await expect(captureElementTree(page, "[", { x: 0, y: 0, width: 80, height: 80 })).rejects.toThrow();
      await paint(page, 0, 1);
      expect(await centerPixel(page)).toEqual([0, 0, 255]);
    } finally {
      await page.close();
    }
  });
});
