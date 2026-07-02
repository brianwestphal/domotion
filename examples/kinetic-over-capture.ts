/**
 * Showcase: a kinetic-text headline animated OVER a real captured app screen.
 *
 * The "creator" recipe that motivates compositing — take a real UI (captured to
 * native SVG), dim it with a scrim for legibility, and lay an animated headline
 * on top. The whole thing is ONE self-contained animated SVG: the background is
 * genuine captured HTML/CSS (crisp, scalable), the headline is the `kinetic-text`
 * template rendered on a TRANSPARENT background so the screen shows through.
 *
 * Three layers, composed with `composeAnimatedLayers`:
 *   1. captured page  (static)   — the sample app, captured at 1280×720
 *   2. scrim          (static)   — a dark bottom-weighted gradient for contrast
 *   3. kinetic-text   (animated) — the headline, background:"transparent"
 *
 * Uses ONLY the public library surface (the same pieces the CLI verbs call):
 * capture → render → `renderTemplateToSvg` → `composeAnimatedLayers`.
 *
 *   npx tsx examples/kinetic-over-capture.ts  →  examples/output/kinetic-over-capture.svg
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
  wrapSvg,
  renderTemplateToSvg,
  kineticTextTemplate,
  composeAnimatedLayers,
} from "../src/index.js";
import { optimizeSvg } from "./shared.js";

const OUT_DIR = resolve("examples/output");
const OUTPUT = resolve(OUT_DIR, "kinetic-over-capture.svg");
const PAGE = resolve("examples/templates/sample-app.html");
const W = 1280;
const H = 720;

/** Capture `PAGE` at W×H as one static, self-contained SVG (the background layer). */
async function captureBackground(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
): Promise<string> {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  try {
    const page = await ctx.newPage();
    await page.goto(`file://${PAGE}`, { waitUntil: "load" });
    await page.waitForTimeout(200);
    const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: W, height: H });
    cullElementsOutsideViewBox(tree, W, H, undefined, 0, 1);
    clearEmbeddedFonts();
    clearGlyphDefs();
    return wrapSvg(elementTreeToSvgInner(tree, W, H), W, H);
  } finally {
    await ctx.close();
  }
}

/** A dark, bottom-weighted scrim so light text reads over the busy capture. */
function scrimSvg(): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<defs><linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="#05060f" stop-opacity="0.72"/>` +
    `<stop offset="0.55" stop-color="#05060f" stop-opacity="0.55"/>` +
    `<stop offset="1" stop-color="#05060f" stop-opacity="0.86"/>` +
    `</linearGradient></defs>` +
    `<rect width="${W}" height="${H}" fill="url(#scrim)"/></svg>`
  );
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  try {
    const background = await captureBackground(browser);

    // The animated headline on a TRANSPARENT background so the screen shows through.
    const headline = await renderTemplateToSvg(
      kineticTextTemplate,
      {
        text: "Your product,\\nin motion",
        variant: "rise",
        by: "word",
        background: "transparent",
        color: "#f8fafc",
        fontSize: 104,
        fontWeight: 800,
        width: W,
        height: H,
      },
      { browser },
    );
    const periodMs = headline.durationMs ?? 4000;

    const result = composeAnimatedLayers(
      [
        { svg: background, x: 0, y: 0, width: W, height: H },
        { svg: scrimSvg(), x: 0, y: 0, width: W, height: H },
        { svg: headline.svg, periodMs, x: 0, y: 0, width: W, height: H },
      ],
      { width: W, height: H, background: "#05060f", durationMs: periodMs },
    );

    const optimized = optimizeSvg(result.svg);
    writeFileSync(OUTPUT, optimized);
    process.stdout.write(
      `Wrote ${OUTPUT} (${(optimized.length / 1024).toFixed(1)} KB, ${result.width}×${result.height}, ` +
        `${(result.durationMs / 1000).toFixed(1)}s loop)\n`,
    );
  } finally {
    await browser.close();
  }
}

void main();
