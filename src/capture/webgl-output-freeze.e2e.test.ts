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

async function makeWebGlPage(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 80, height: 80 } });
  await page.setContent('<canvas width="32" height="32"></canvas>');
  const supported = await evaluateInFrame(page, () => {
    const canvas = document.querySelector("canvas");
    const gl = canvas?.getContext("webgl", { preserveDrawingBuffer: true });
    if (gl == null) return false;
    gl.clearColor(1, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return true;
  });
  expect(supported).toBe(true);
  await expect.poll(() => centerPixel(page), { timeout: 15_000 }).toEqual([255, 0, 0]);
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

describe("capture-scoped WebGL output freeze", () => {
  it("holds the presented pixels and restores drawing after disposal", async () => {
    const page = await makeWebGlPage();
    try {
      const frozen = await freezeWebGlOutputForCapture(page);
      expect(frozen.frozenFrames).toBe(1);
      try {
        await paint(page, 0, 1);
        // Hosted software compositing can briefly show a gray placeholder
        // when the canvas layer is recycled after freezing. The held red frame
        // must become visible without ever allowing the new blue draw through.
        const deadline = Date.now() + 5_000;
        let pixel = await centerPixel(page);
        while (pixel[0] === pixel[1] && pixel[1] === pixel[2] && Date.now() < deadline) {
          await page.waitForTimeout(100);
          pixel = await centerPixel(page);
        }
        expect(pixel).toEqual([255, 0, 0]);
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
        const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 80, height: 80 });
        const uri = walk(tree).find((node) => node.tag === "canvas")?.replacedSnapshot?.dataUri;
        expect(uri).toMatch(/^data:image\/png;base64,/);
        const pixels = await sharp(Buffer.from(uri!.split(",")[1], "base64"))
          .extract({ left: 16, top: 16, width: 1, height: 1 })
          .removeAlpha()
          .raw()
          .toBuffer();
        expect(Array.from(pixels)).toEqual([255, 0, 0]);
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
