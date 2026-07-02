/**
 * Example: `domotion capture --format` (DM-1538). One local page captured onto
 * two platform canvases via the shared format machinery — a 9:16 `reel` and a
 * 16:9 `landscape` — the way `domotion capture <page> --format <name>` sizes the
 * capture VIEWPORT. The reel variant also overlays the `--safe-guide` (a dashed
 * rectangle marking where a format's platform-UI margins land — informational; it
 * reflows nothing).
 *
 * Uses ONLY the public library surface (the same pieces the CLI's `capture` verb
 * calls): `resolveFormat` + `safeAreaGuideSvg` + capture → render → wrap.
 *
 * Outputs land in examples/output/. Run: npx tsx examples/format-capture-demo.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import {
  captureElementTree,
  elementTreeToSvgInner,
  clearEmbeddedFonts,
  clearGlyphDefs,
  cullElementsOutsideViewBox,
  resolveFormat,
  safeAreaGuideSvg,
  wrapSvg,
} from "../src/index.js";
import { optimizeSvg } from "./shared.js";

const OUT_DIR = resolve("examples/output");
const PAGE = resolve("examples/templates/sample-app.html");

/** Capture `PAGE` at a format's viewport size, optionally overlaying the safe guide. */
async function captureAtFormat(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  format: string,
  safeGuide: boolean,
): Promise<{ svg: string; width: number; height: number }> {
  const { width, height, safeInset } = resolveFormat(format);
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  try {
    const page = await ctx.newPage();
    await page.goto(`file://${PAGE}`, { waitUntil: "load" });
    await page.waitForTimeout(200);
    const tree = await captureElementTree(page, "body", { x: 0, y: 0, width, height });
    cullElementsOutsideViewBox(tree, width, height, undefined, 0, 1);
    clearEmbeddedFonts();
    clearGlyphDefs();
    let svg = wrapSvg(elementTreeToSvgInner(tree, width, height), width, height);
    if (safeGuide) svg = svg.replace(/<\/svg>\s*$/, `${safeAreaGuideSvg(width, height, safeInset)}</svg>`);
    return { svg, width, height };
  } finally {
    await ctx.close();
  }
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  try {
    const jobs: Array<{ file: string; format: string; safeGuide: boolean }> = [
      { file: "format-capture-reel", format: "reel", safeGuide: true }, // 1080×1920 + safe-area guide
      { file: "format-capture-landscape", format: "landscape", safeGuide: false }, // 1920×1080
    ];
    for (const j of jobs) {
      const { svg, width, height } = await captureAtFormat(browser, j.format, j.safeGuide);
      const optimized = optimizeSvg(svg);
      const out = resolve(OUT_DIR, `${j.file}.svg`);
      writeFileSync(out, optimized);
      process.stdout.write(`Wrote ${out} (${(optimized.length / 1024).toFixed(1)} KB, ${width}×${height})\n`);
    }
  } finally {
    await browser.close();
  }
}

void main();
