/** Debug reproduction artifacts for declarative animation frames. */

import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Page } from "@playwright/test";
import type { CapturedElement } from "../capture/types.js";

/** Ensure programmatic `ComposeAnimateOptions.debugDir` callers need no setup. */
export function prepareAnimateDebugBundle(debugDir: string): void {
  mkdirSync(debugDir, { recursive: true });
}

function frameDirectory(debugDir: string, index: number, frameCount: number): string {
  const digits = Math.max(3, String(Math.max(0, frameCount - 1)).length);
  return join(debugDir, "frames", String(index).padStart(digits, "0"));
}

interface AnimateDebugFrameBase {
  debugDir: string;
  index: number;
  frameCount: number;
  width: number;
  height: number;
  tree: CapturedElement[] | null;
  log: (message: string) => void;
}

export interface LiveAnimateDebugFrameRequest extends AnimateDebugFrameBase {
  page: Page;
}

/** Write the source-browser pixels and raw captured tree for a DOM-backed frame. */
export async function writeLiveAnimateDebugFrame(request: LiveAnimateDebugFrameRequest): Promise<void> {
  const dir = frameDirectory(request.debugDir, request.index, request.frameCount);
  mkdirSync(dir, { recursive: true });
  await request.page.screenshot({
    path: join(dir, "expected.png"),
    clip: { x: 0, y: 0, width: request.width, height: request.height },
    omitBackground: false,
  });
  writeFileSync(join(dir, "captured-tree.json"), JSON.stringify(request.tree, null, 2));
  request.log(`  debug: frames/${basename(dir)}/expected.png + captured-tree.json`);
}

export interface EmbeddedAnimateDebugFrameRequest extends AnimateDebugFrameBase {
  /** The persistent session page supplies the headless BrowserContext. */
  sessionPage: Page;
  svgContent: string;
  fontFaceCss: string;
}

/**
 * Embedded cast/template frames have no source DOM tree. Rasterize the exact
 * nested frame content in Chromium and write JSON `null` as the explicit tree
 * sentinel, so every composed frame still has a complete artifact pair.
 */
export async function writeEmbeddedAnimateDebugFrame(request: EmbeddedAnimateDebugFrameRequest): Promise<void> {
  const dir = frameDirectory(request.debugDir, request.index, request.frameCount);
  mkdirSync(dir, { recursive: true });
  const page = await request.sessionPage.context().newPage();
  try {
    await page.setViewportSize({ width: request.width, height: request.height });
    await page.setContent(
      `<!doctype html><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}</style>`
      + `<svg xmlns="http://www.w3.org/2000/svg" width="${request.width}" height="${request.height}" viewBox="0 0 ${request.width} ${request.height}">`
      + `<style>${request.fontFaceCss}</style>${request.svgContent}</svg>`,
      { waitUntil: "load" },
    );
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => {
      for (const animation of document.getAnimations()) {
        animation.pause();
        animation.currentTime = 0;
      }
      const svg = document.querySelector("svg");
      if (svg != null && "pauseAnimations" in svg && typeof svg.pauseAnimations === "function") {
        svg.pauseAnimations();
        svg.setCurrentTime(0);
      }
    });
    await page.screenshot({
      path: join(dir, "expected.png"),
      clip: { x: 0, y: 0, width: request.width, height: request.height },
      omitBackground: false,
    });
  } finally {
    await page.close();
  }
  writeFileSync(join(dir, "captured-tree.json"), "null");
  request.log(`  debug: frames/${basename(dir)}/expected.png + captured-tree.json (embedded frame)`);
}

/** Store the final, optimized animation as plain SVG even when output is SVGZ/stdout. */
export function writeAnimateDebugActual(debugDir: string, svg: string): void {
  writeFileSync(join(debugDir, "actual.svg"), svg);
}

export function logAnimateDebugBundle(
  debugDir: string,
  log: (message: string) => void,
): void {
  log(
    `Debug bundle written:\n`
    + `  ${join(debugDir, "capture.har")}          (shared Playwright HAR)\n`
    + `  ${join(debugDir, "actual.svg")}           (final produced animation)\n`
    + `  ${join(debugDir, "frames", "NNN", "expected.png")}    (Chromium source pixels per frame)\n`
    + `  ${join(debugDir, "frames", "NNN", "captured-tree.json")} (raw tree per frame; null for compound/embedded frames)`,
  );
}
