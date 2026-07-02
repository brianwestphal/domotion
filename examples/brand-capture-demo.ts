/**
 * Example: brand for `capture` (DM-1540, docs/92). Theming a *captured real page*
 * is a distinct mechanism from a template's brand defaults — the brand's tokens
 * are injected as CSS custom properties onto the page's `:root` BEFORE it paints,
 * so a page authored against `var(--brand-*)` picks up the palette / font /
 * radius. This is exactly what `domotion capture <page> --brand acme.json` does,
 * shown here through the public library API.
 *
 * Fixture: examples/templates/brand-page.html — authored against the brand vars
 * with neutral fallbacks. Brand: examples/templates/acme-brand.json.
 *
 * Output lands in examples/output/brand-capture.svg.
 *
 * Usage: npx tsx examples/brand-capture-demo.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  launchChromium,
  injectBrandVariables,
  captureElementTree,
  elementTreeToSvg,
  loadBrand,
} from "../src/index.js";
import { optimizeSvg } from "./shared.js";

const OUT_DIR = resolve("examples/output");
const PAGE = resolve("examples/templates/brand-page.html");
const BRAND = loadBrand(resolve("examples/templates/acme-brand.json"));
const W = 720, H = 360;

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const browser = await launchChromium();
  try {
    const ctx = await browser.newContext({ viewport: { width: W, height: H } });
    // Inject the brand's CSS variables onto :root before the page loads/paints.
    await injectBrandVariables(ctx, BRAND);
    const page = await ctx.newPage();
    await page.goto(pathToFileURL(PAGE).href, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: W, height: H });
    const svg = optimizeSvg(elementTreeToSvg(tree, W, H));
    const out = resolve(OUT_DIR, "brand-capture.svg");
    writeFileSync(out, svg);
    process.stdout.write(`Wrote ${out} (${(svg.length / 1024).toFixed(1)} KB, ${W}×${H})\n`);
    await ctx.close();
  } finally {
    await browser.close();
  }
}

void main();
